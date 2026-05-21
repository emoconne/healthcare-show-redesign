# healthcare-show

JBCC Healthcare Exhibition demo application.

## API Configuration

Create a local `.env` file (or set environment variables in your shell) using the template in `.env.example`.

Required variables:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_DEPLOYMENT` (default: `gpt-4o`)
- `AZURE_SPEECH_KEY`
- `AZURE_SPEECH_REGION` (use `japaneast`)

Optional variables:

- `COSMOS_CONNECTION_STRING`
- `COSMOS_DATABASE` (default: `healthcaredb`)
- `COSMOS_CONTAINER` (default: `conversations`)
- `PORT` (default: `8080`)

## Current Azure Speech Resource (JBCC Tenant)

- Resource Group: `tsunagcrm`
- Resource Name: `tsunagcrm-speech-64195`
- Region: `japaneast`
- Endpoint: `https://tsunagcrm-speech-64195.cognitiveservices.azure.com/`

Notes:

- The app uses one Azure Speech resource for both TTS and STT.
- Do not commit real keys.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from `.env.example` and fill your real values.

3. Start the server:

   ```bash
   npm start
   ```

4. Open:

   - `http://localhost:8080`

## API Endpoints

- `POST /api/chat` : Azure OpenAI chat
- `POST /api/tts` : Azure Speech TTS
- `GET /api/speech/token` : Azure Speech STT token for browser SDK
- `GET /api/logs` : Cosmos DB conversation logs
- `GET /api/health` : service health summary
