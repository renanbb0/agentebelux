const { execSync } = require('child_process');
const axios = require('axios');
require('dotenv').config();

async function run() {
  try {
    let ngrokUrl = '';
    try {
      const curlRes = execSync('curl.exe -s http://localhost:4040/api/tunnels');
      const tunnels = JSON.parse(curlRes).tunnels;
      ngrokUrl = tunnels[0].public_url;
      console.log('Ngrok URL found:', ngrokUrl);
    } catch(e) {
      console.error('Failed to get ngrok URL:', e.message);
      return;
    }

    const { data } = await axios.put(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/webhooks`,
      { value: `${ngrokUrl}/webhook` }
    );
    console.log('Webhook updated successfully to:', data.value);
  } catch(e) {
    console.error('Error updating webhook:', e.response?.data || e.message);
  }
}
run();
