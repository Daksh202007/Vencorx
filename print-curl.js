const crypto = require('crypto');
const net = require('net');

async function getRedisValue(key) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ port: 6379, host: 'localhost' }, () => {
      client.write(`GET ${key}\r\n`);
    });

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      // Simple RESP parser for bulk string
      if (data.includes('\r\n')) {
        const lines = data.split('\r\n');
        if (lines[0].startsWith('$')) {
          if (lines.length >= 3) {
            resolve(lines[1]);
            client.end();
          }
        } else {
          resolve(null);
          client.end();
        }
      }
    });

    client.on('error', (err) => {
      reject(err);
    });
  });
}

async function generateCurl() {
  const appId = "F7USKVHE4E-200";
  const secretId = "sVqq9vozwuP1QtE8";
  const pin = "2007";
  
  try {
    const refreshToken = await getRedisValue('fyers_refresh_token');
    
    if (!refreshToken) {
      console.log('Error: Could not find refresh token in Redis');
      process.exit(1);
    }
    
    const appIdHash = crypto.createHash('sha256').update(`${appId}:${secretId}`).digest('hex');
    
    const payload = {
      grant_type: 'refresh_token',
      appIdHash: appIdHash,
      refresh_token: refreshToken,
      pin: pin,
    };
    
    const curlCmd = `curl -X POST https://api-t1.fyers.in/api/v3/validate-refresh-token \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(payload)}'`;
    
    console.log('\n--- COPY THE CURL COMMAND BELOW ---\n');
    console.log(curlCmd);
    console.log('\n-----------------------------------\n');
    
  } catch(e) {
    console.log(e);
  }
}

generateCurl();
