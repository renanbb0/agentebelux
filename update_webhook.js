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

    // Z-API endpoint to update received message webhook
    const endpoint = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/update-webhook-received`;
    
    console.log('Updating webhook at:', endpoint);
    
    const { data } = await axios.put(
      endpoint,
      { value: `${ngrokUrl}/webhook` },
      { headers: { 'Client-Token': process.env.ZAPI_CLIENT_TOKEN } }
    );
    
    console.log('Webhook update response:', JSON.stringify(data, null, 2));
    
    if (data.value || data.status === 'success') {
      console.log('✅ Webhook updated successfully to:', `${ngrokUrl}/webhook`);
    } else {
      console.warn('⚠️ Webhook update might have failed. Response above.');
    }
  } catch(e) {
    console.error('❌ Error updating webhook:', e.response?.data || e.message);
  }
}
run();
