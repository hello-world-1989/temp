import axios from 'axios';

const APPLE_ID_URL = process.env.APPLE_ID_URL;
const HTTP_PROXY = process.env.HTTP_PROXY; // Optional proxy for bypassing domain restrictions

export async function getAppleId() {
  console.log('---getting apple id ---');

  const axiosConfig = {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'sec-ch-ua': '"Chromium";v="140", "Google Chrome";v="140", "Not A(Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'dnt': '1',
      'upgrade-insecure-requests': '1',
      Origin: 'https://idshare001.me',
      Referer: 'https://idshare001.me/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'sec-fetch-user': '?1',
      'Cache-Control': 'max-age=0',
      'Cookie': 'last_visited_page=404.html',
      ':authority': 'idshare001.me',
    },
  };

  // Add proxy configuration if HTTP_PROXY environment variable is set
  if (HTTP_PROXY) {
    const proxyUrl = new URL(HTTP_PROXY);
    axiosConfig.proxy = {
      protocol: proxyUrl.protocol.slice(0, -1), // Remove trailing ':'
      host: proxyUrl.hostname,
      port: parseInt(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80),
    };
    console.log('Using proxy:', HTTP_PROXY);
  }

  try {
    const res = await axios.get(APPLE_ID_URL, axiosConfig);

    const resData = res.data;

    console.log('resData: ', resData);
    //   const passwordRegex = /密码：(.*?)</;
    let username = resData?.[0]?.username;
    let password = resData?.[0]?.password;
    let expireDate = resData?.[0]?.time;

    console.log('Success:', username, password, expireDate);

    return [username, password, expireDate];
    //   console.log('Success:', htmlString);
  } catch (error) {
    console.error('--- Apple ID Request Failed ---');
    console.error('URL:', APPLE_ID_URL);
    console.error('Using Proxy:', HTTP_PROXY ? 'Yes' : 'No');
    
    if (error.response?.status === 403) {
      console.error('403 Forbidden - Domain/Origin not allowed. Try setting HTTP_PROXY environment variable.');
      console.error('Current referer: https://idshare001.me');
      console.error('Target URL:', APPLE_ID_URL);
    } else if (error.response) {
      console.error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      if (error.response.data) {
        console.error('Response data:', error.response.data);
      }
    } else if (error.code === 'ECONNREFUSED') {
      console.error('Connection refused - server may be down or unreachable');
    } else if (error.code === 'ENOTFOUND') {
      console.error('DNS resolution failed - check your internet connection and DNS settings');
    } else if (error.code === 'ECONNRESET') {
      console.error('Connection reset - network issue or proxy problem');
    } else {
      console.error('Request failed:', error.message);
      console.error('Error code:', error.code);
    }
    throw error;
  }
}

// getAppleId();
