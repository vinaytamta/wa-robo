const fetch = require('node-fetch');

async function testAnalyticsAPI() {
  try {
    // First login to get a token
    const loginResponse = await fetch('http://localhost:3001/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME || 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin'
      })
    });

    const loginData = await loginResponse.json();
    console.log('Login response:', loginData.success ? 'Success' : 'Failed');

    if (!loginData.token) {
      console.error('No token received');
      return;
    }

    const token = loginData.token;

    // Test analytics endpoints
    console.log('\nTesting analytics endpoints...');

    const endpoints = [
      '/api/analytics/top-groups?days=30',
      '/api/analytics/engagement-trends?days=30',
      '/api/analytics/weekly-comparison',
      '/api/analytics/engagement-by-day?days=30'
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`http://localhost:3001${endpoint}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        console.log(`\n${endpoint}:`);
        console.log('  Status:', response.status);
        console.log('  Data length:', Array.isArray(data) ? data.length : 'Not an array');
        console.log('  Sample:', JSON.stringify(data).substring(0, 100));
      } catch (error) {
        console.error(`  Error: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

testAnalyticsAPI();
