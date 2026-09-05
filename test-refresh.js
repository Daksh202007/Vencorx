const crypto = require('crypto');
require('dotenv').config();
const Redis = require('ioredis');

async function testFyersRefresh() {
  const redis = new Redis('redis://localhost:6379');
  
  try {
    const appId = process.env.FYERS_APP_ID;
    const secretId = process.env.FYERS_SECRET_ID;
    const pin = process.env.FYERS_PIN;
    
    console.log('App ID:', appId);
    console.log('Secret ID:', secretId);
    console.log('PIN:', pin);
    
    const refreshToken = await redis.get('fyers_refresh_token');
    
    if (!refreshToken) {
      console.log('❌ NO REFRESH TOKEN IN REDIS!');
      process.exit(1);
    }
    
    console.log('Found Refresh Token:', refreshToken.substring(0, 20) + '...');
    
    const appIdHash = crypto.createHash('sha256').update(`${appId}:${secretId}`).digest('hex');
    console.log('AppIdHash:', appIdHash);

    const payload = {
      grant_type: 'refresh_token',
      appIdHash: appIdHash,
      refresh_token: refreshToken,
      pin: pin,
    };
    
    console.log('Sending payload...', JSON.stringify(payload).substring(0, 100) + '...');

    const response = await fetch('https://api-t1.fyers.in/api/v3/validate-refresh-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (response.ok) {
      console.log('✅ SUCCESS!');
      console.log(data);
    } else {
      console.log('❌ FAILED!');
      console.log('Status Code:', response.status);
      console.log('Fyers Error Message:', data);
    }

  } catch (error) {
    console.log('❌ FAILED (Network/Fatal Error)!');
    console.log(error);
  } finally {
    redis.quit();
  }
}

testFyersRefresh();
