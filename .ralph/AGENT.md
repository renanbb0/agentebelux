# Bela Belux - Build & Execution Instructions

## Build
The project uses **Node.js**.

```bash
npm install
```

## Running the Application
```bash
# Start the webhook server
node index.js
```

## Testing
Currently, the task list includes building a test suite. 

## Environment Variables
The following keys are required in `.env`:
- `PORT` (default: 3000)
- `ADMIN_PHONE`
- `TTS_ENABLED`
- `SUPABASE_URL` / `SUPABASE_KEY`
- `ZAPI_INSTANCE_ID` / `ZAPI_TOKEN`
- `WOOCOMMERCE_URL` / `CONSUMER_KEY` / `CONSUMER_SECRET`
- `GEMINI_API_KEY`
