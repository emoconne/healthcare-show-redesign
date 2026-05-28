const express = require('express');
const path = require('path');
const fs = require('fs');
const { CosmosClient } = require('@azure/cosmos');
const { AzureOpenAI } = require('openai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname), {
  index: 'index.html',
  extensions: ['html']
}));

const SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'japaneast';

const TTS_ENGINE = process.env.TTS_ENGINE || 'azure';
const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://localhost:50021';
const VOICEVOX_SPEAKER = parseInt(process.env.VOICEVOX_SPEAKER || '3');

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

async function synthesizeWithVoicevox(cleanText, res) {
  const queryRes = await fetch(
    `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(cleanText)}&speaker=${VOICEVOX_SPEAKER}`,
    { method: 'POST' }
  );
  if (!queryRes.ok) {
    const errText = await queryRes.text();
    throw new Error(`VOICEVOX audio_query failed: ${queryRes.status} ${errText}`);
  }

  const audioQuery = await queryRes.json();
  audioQuery.speedScale = 1.15;

  const synthRes = await fetch(
    `${VOICEVOX_URL}/synthesis?speaker=${VOICEVOX_SPEAKER}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(audioQuery)
    }
  );
  if (!synthRes.ok) {
    const errText = await synthRes.text();
    throw new Error(`VOICEVOX synthesis failed: ${synthRes.status} ${errText}`);
  }

  const audioBuffer = Buffer.from(await synthRes.arrayBuffer());
  res.set({
    'Content-Type': 'audio/wav',
    'Content-Length': audioBuffer.length,
    'Cache-Control': 'no-cache'
  });
  res.send(audioBuffer);
}

async function synthesizeWithAzure(cleanText, voice, rate, res) {
  if (!SPEECH_KEY) {
    throw new Error('Azure Speech not configured');
  }

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ja-JP">
  <voice name="${voice}">
    <prosody rate="${rate}">${cleanText}</prosody>
  </voice>
</speak>`;

  const ttsUrl = `https://${SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const response = await fetch(ttsUrl, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'healthcare-show'
    },
    body: ssml
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Azure TTS failed: ${response.status} ${errText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  res.set({
    'Content-Type': 'audio/mpeg',
    'Content-Length': audioBuffer.length,
    'Cache-Control': 'no-cache'
  });
  res.send(audioBuffer);
}

app.post('/api/tts', async (req, res) => {
  const { text, voice = 'ja-JP-NanamiNeural', rate = '+15%' } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text required' });
  }

  const cleanText = text.replace(/<[^>]*>/g, '').replace(/[🏥✨📊▸]/g, '').trim();
  if (!cleanText) {
    return res.status(400).json({ error: 'no speakable text' });
  }

  if (TTS_ENGINE === 'voicevox') {
    try {
      await synthesizeWithVoicevox(cleanText, res);
      return;
    } catch (err) {
      console.error('VOICEVOX TTS error:', err.message);
      if (SPEECH_KEY) {
        console.log('Falling back to Azure TTS...');
      } else {
        return res.status(500).json({ error: 'VOICEVOX TTS failed and Azure Speech not configured' });
      }
    }
  }

  if (!SPEECH_KEY) {
    return res.status(503).json({ error: 'Azure Speech not configured' });
  }

  try {
    await synthesizeWithAzure(cleanText, voice, rate, res);
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: 'TTS生成に失敗しました' });
  }
});

app.get('/api/speech/token', async (req, res) => {
  if (!SPEECH_KEY) {
    return res.status(503).json({ error: 'Azure Speech not configured' });
  }

  try {
    const tokenUrl = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': SPEECH_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': '0'
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Speech token error:', response.status, errText);
      return res.status(500).json({ error: 'Speech token generation failed' });
    }

    const token = await response.text();
    res.set({ 'Cache-Control': 'no-cache' });
    res.json({ token, region: SPEECH_REGION, expiresIn: 600 });
  } catch (err) {
    console.error('Speech token error:', err.message);
    res.status(500).json({ error: 'Speech token generation failed' });
  }
});

app.get('/api/welcome-stream', async (req, res) => {
  if (!openaiClient) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('こんにちは！JBCCブースへようこそ。銀河鉄道に乗って、病院DXの旅にでかけましょう！クラウド電子カルテ「blanc」やAI活用、クラウド移行など、病院DXを総合的にご案内しております。各コーナーをお気軽にご覧ください。');
    return;
  }

  let eventGuide = '';
  try {
    eventGuide = fs.readFileSync(path.join(__dirname, 'event-guide.md'), 'utf-8');
  } catch (e) {
    eventGuide = 'JBCCホスピタルショウ2026ブース。電子カルテblancやAI活用、クラウド移行などをご案内。';
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const stream = await openaiClient.chat.completions.create({
      model: OPENAI_DEPLOYMENT,
      messages: [
        {
          role: 'system',
          content: `あなたはJBCCブースのAIアテンド「J-ポッポ」です。ホスピタルショウ2026の来場者に向けて挨拶し、このブースの特長を紹介してください。

以下のブース情報を参考にしてください：
${eventGuide}

ルール：
- 必ず「こんにちは！JBCCブースへようこそ。銀河鉄道に乗って、病院DXの旅にでかけましょう！」から始めてください
- その後に200文字程度で、ブースの見どころや特長を紹介
- 温かく親しみやすいトーンで
- 毎回少し違う表現にしてバリエーションを持たせてください
- 来場者が興味を持つようなフレーズを入れてください
- 絵文字は使わないでください`
        },
        { role: 'user', content: '来場者への挨拶とブース紹介をお願いします。' }
      ],
      max_tokens: 300,
      temperature: 0.9,
      stream: true
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Welcome stream error:', err.message);
    res.write(`data: ${JSON.stringify({ text: 'こんにちは！JBCCブースへようこそ。銀河鉄道に乗って、病院DXの旅にでかけましょう！クラウド電子カルテ「blanc」やAI活用、クラウド移行など、病院DXを総合的にご案内しております。各コーナーをお気軽にご覧ください。' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

const MENU_CONTENT_FILES = {
  'blanc-general': 'content/blanc-general.md',
  'blanc-psychiatric': 'content/blanc-psychiatric.md',
  'dx-ai': 'content/dx-ai.md',
  'cloud-migration': 'content/cloud-migration.md',
  'lab-system': 'content/lab-system.md',
  'security': 'content/security.md',
  'consultation': 'content/consultation.md'
};

app.post('/api/menu-chat', async (req, res) => {
  const { messages, menuType, sessionId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const contentFile = MENU_CONTENT_FILES[menuType];
  let systemPrompt = 'あなたはJBCCブースのAIアテンドです。来場者の質問に丁寧に回答してください。';
  if (contentFile) {
    try {
      systemPrompt = fs.readFileSync(path.join(__dirname, contentFile), 'utf-8');
    } catch (e) {}
  }

  if (!openaiClient) {
    return res.json({ reply: 'こちらのコーナーについてご案内いたします。詳しくはブースの担当者にお声がけください。' });
  }

  try {
    const completion = await openaiClient.chat.completions.create({
      model: OPENAI_DEPLOYMENT,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 400,
      temperature: 0.7
    });
    const reply = completion.choices[0]?.message?.content || '';
    res.json({ reply });
  } catch (err) {
    console.error('Menu chat error:', err.message);
    res.status(500).json({ error: 'AI応答の生成に失敗しました' });
  }
});

app.get('/api/menu-greeting-stream', async (req, res) => {
  const menuType = req.query.menuType;
  const contentFile = MENU_CONTENT_FILES[menuType];
  let systemPrompt = 'あなたはJBCCブースのAIアテンドです。';
  if (contentFile) {
    try { systemPrompt = fs.readFileSync(path.join(__dirname, contentFile), 'utf-8'); } catch {}
  }

  if (!openaiClient) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('こちらのコーナーについてご案内いたします。ご興味のある内容をお選びください。');
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const stream = await openaiClient.chat.completions.create({
      model: OPENAI_DEPLOYMENT,
      messages: [
        { role: 'system', content: systemPrompt + '\n\nルール：\n- 100文字程度で簡潔にこのコーナーの特長を紹介\n- 温かく親しみやすいトーンで\n- 毎回少し違う表現にしてください\n- 絵文字は使わないでください' },
        { role: 'user', content: 'このコーナーの特長を100文字程度で紹介してください。' }
      ],
      max_tokens: 150,
      temperature: 0.9,
      stream: true
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Menu greeting stream error:', err.message);
    res.write(`data: ${JSON.stringify({ text: 'こちらのコーナーについてご案内いたします。ご興味のある内容をお選びください。' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

app.get('/api/health', async (req, res) => {
  let voicevoxAvailable = false;
  try {
    const vvRes = await fetch(`${VOICEVOX_URL}/version`, { signal: AbortSignal.timeout(2000) });
    voicevoxAvailable = vvRes.ok;
  } catch (_) {
    voicevoxAvailable = false;
  }

  res.json({
    status: 'ok',
    openai: !!openaiClient,
    cosmos: !!cosmosContainer,
    speech: !!SPEECH_KEY,
    voicevox: voicevoxAvailable,
    ttsEngine: TTS_ENGINE,
    timestamp: new Date().toISOString()
  });
});

initCosmos();
initOpenAI();

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Healthcare Show server running on port ${PORT}`);
});
