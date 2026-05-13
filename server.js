const express = require('express');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');
const { AzureOpenAI } = require('openai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname), {
  index: 'index.html',
  extensions: ['html']
}));

const OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const OPENAI_KEY = process.env.AZURE_OPENAI_KEY;
const OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
const COSMOS_CONNECTION = process.env.COSMOS_CONNECTION_STRING;
const COSMOS_DB = process.env.COSMOS_DATABASE || 'healthcaredb';
const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || 'conversations';

let cosmosContainer = null;
let openaiClient = null;

function initCosmos() {
  if (!COSMOS_CONNECTION) return null;
  try {
    const client = new CosmosClient(COSMOS_CONNECTION);
    const db = client.database(COSMOS_DB);
    cosmosContainer = db.container(COSMOS_CONTAINER);
    console.log('Cosmos DB connected');
    return cosmosContainer;
  } catch (err) {
    console.error('Cosmos DB init failed:', err.message);
    return null;
  }
}

function initOpenAI() {
  if (!OPENAI_ENDPOINT || !OPENAI_KEY) return null;
  try {
    openaiClient = new AzureOpenAI({
      endpoint: OPENAI_ENDPOINT,
      apiKey: OPENAI_KEY,
      apiVersion: '2024-10-21',
      deployment: OPENAI_DEPLOYMENT
    });
    console.log('Azure OpenAI connected');
    return openaiClient;
  } catch (err) {
    console.error('Azure OpenAI init failed:', err.message);
    return null;
  }
}

app.post('/api/chat', async (req, res) => {
  if (!openaiClient) {
    return res.status(503).json({ error: 'Azure OpenAI not configured' });
  }

  const { messages, sessionId, demoType } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const systemPrompts = {
    reception: `あなたは「銀河鉄道病院」の受付AIナースです。丁寧な日本語で対応してください。
患者様の来院目的を聞き、適切な診療科をご案内してください。
初診・再診の確認、保険証の確認なども行ってください。
温かく親切な対応を心がけてください。`,
    consulting: `あなたはJBCCヘルスケア部門のAIコンサルタントです。
病院経営、医療DX、電子カルテ導入、クラウド移行などについてアドバイスしてください。
専門的かつ実践的な助言を、分かりやすい日本語で提供してください。`
  };

  const systemMessage = systemPrompts[demoType] || systemPrompts.reception;

  try {
    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_DEPLOYMENT,
      messages: [
        { role: 'system', content: systemMessage },
        ...messages
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    const reply = completion.choices[0]?.message?.content || '';

    if (cosmosContainer && sessionId) {
      try {
        await cosmosContainer.items.create({
          sessionId,
          demoType: demoType || 'unknown',
          messages: [...messages, { role: 'assistant', content: reply }],
          timestamp: new Date().toISOString(),
          id: `${sessionId}-${Date.now()}`
        });
      } catch (logErr) {
        console.error('Log save failed:', logErr.message);
      }
    }

    res.json({ reply });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'AI応答の生成に失敗しました' });
  }
});

app.get('/api/logs', async (req, res) => {
  if (!cosmosContainer) {
    return res.status(503).json({ error: 'Cosmos DB not configured' });
  }
  const { sessionId, limit = 50 } = req.query;
  try {
    let query = 'SELECT * FROM c ORDER BY c.timestamp DESC OFFSET 0 LIMIT @limit';
    const params = [{ name: '@limit', value: parseInt(limit) }];
    if (sessionId) {
      query = 'SELECT * FROM c WHERE c.sessionId = @sid ORDER BY c.timestamp DESC';
      params.push({ name: '@sid', value: sessionId });
    }
    const { resources } = await cosmosContainer.items.query({ query, parameters: params }).fetchAll();
    res.json({ logs: resources });
  } catch (err) {
    console.error('Log fetch error:', err.message);
    res.status(500).json({ error: 'ログの取得に失敗しました' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    openai: !!openaiClient,
    cosmos: !!cosmosContainer,
    timestamp: new Date().toISOString()
  });
});

initCosmos();
initOpenAI();

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Healthcare Show server running on port ${PORT}`);
});
