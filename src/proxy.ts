import axios from 'axios';
import * as express from 'express';
import * as fs2 from 'node:fs/promises';
import * as path from 'path';
import * as net from 'net';
import { create } from 'express-handlebars';

const hostsMap = new Map<string, any>();
let endGFWHosts: any[] = [];
const NODE_PORT = process.env.NODE_PORT || 80;
let vpnData: any[] = [];
let eeData: any[] = [];

const app = express();

const hbs = create({
  // Specify helpers which are only registered on this instance.
  helpers: {
    foo() {
      return 'FOO!';
    },
    bar() {
      return 'BAR!';
    },
  },
});

app.engine('handlebars', hbs.engine);
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, './views'));

app.use('/', express.static(path.join(__dirname, '../public/temp')));

axios.defaults.headers.common['Accept-Language'] =
  'zh-CN,zh;q=0.9,en-US;q=0.8,en;';

axios.defaults.headers.common['User-Agent'] =
  'Mozilla/5.0 (X11; Linux x86_64; rv:12.0) Gecko/20100101 Firefox/21.0';

axios.defaults.headers.common['Access-Control-Allow-Origin'] = '*';

app.get('/tweet-page', async (req, res) => {
  const year = req.query?.year;
  const month = req.query?.month;
  const day = req.query?.day;
  const id = req.query?.id;

  console.log('year: ', year);
  console.log('id: ', id);

  try {
    const response = await axios.get(
      `https://raw.githubusercontent.com/hello-world-1989/json/main/tweet/${year}/${month}/${day}/${id}.json`
    );

    const tweets = response?.data
      ?.sort((a: any, b: any) => (a.createdDate > b.createdDate ? -1 : 1))
      .map((item: any) => {
        const images = item?.images?.split(',');

        if (item.videos) {
          const videoImages = item.videos?.split(',');
          images.push(...videoImages);
        }

        const nonEmpty = images.filter((item) => item);

        item.allImages = nonEmpty;

        return item;
      });

    const pdfData = {
      tweets,
      baseUrl: 'https://end-gfw.com',
    };

    res.render('tweet', pdfData);
  } catch (err) {
    console.log(err);
  }
});

app.use('/github', async (req, res) => {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/hello-world-1989/cn-news/main/server.txt'
    );

    res.send(response?.data);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/ss-key', async (req, res) => {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/hello-world-1989/cn-news/main/end-gfw-together-ss'
    );

    const base64String = response?.data;

    const array = base64String.split('\r\n');

    console.log('array: ', array);

    let result = '';

    if (array.length > 0) {
      result = array[array.length - 1];
    }

    res.send(result);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/youtube', async (req, res) => {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/hello-world-1989/accessible/main/youtube.json'
    );

    res.send(response?.data);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/obfs4', async (req, res) => {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/hello-world-1989/cn-news/main/obfs4.json'
    );

    res.send(response?.data);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/wiki', async (req, res) => {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/hello-world-1989/accessible/main/wiki.json'
    );

    res.send(response?.data);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/nitter', async (req, res) => {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/hello-world-1989/accessible/main/nitter.json'
    );

    res.send(response?.data);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/searchx', async (req, res) => {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/hello-world-1989/accessible/main/searchx.json'
    );

    res.send(response?.data);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/host2', async (req, res) => {
  try {
    let result: any[] = [];
    const hiddenHost1 = endGFWHosts?.[0];
    const hiddenHost2 = endGFWHosts?.[1];

    if (hiddenHost1) {
      result.push({
        hostname: hiddenHost1.ip,
        status: 'success',
      });
    }

    if (hiddenHost2) {
      result.push({
        hostname: hiddenHost2.ip,
        status: 'success',
      });
    }

    res.send(result);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/host', async (req, res) => {
  try {
    console.log('get top 5 hosts: ', endGFWHosts);

    res.send(endGFWHosts.slice(0, 5));
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/pdf', async (req, res) => {
  try {
    const response = await axios.get(
      'https://raw.githubusercontent.com/hello-world-1989/whyyoutouzhele/main/pdf.json'
    );

    res.send(response?.data);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/news-data', async (req, res) => {
  try {
    const year = req.query?.year;
    const month = req.query?.month;
    const day = req.query?.day;
    // const id = req.query?.id;

    console.log('year: ', year);

    let result: any[] = [];
    const newsSource: string[] = ['bbc', 'dw', 'rfa', 'rfi', 'voa'];

    for (const id of newsSource) {
      try {
        const response = await axios.get(
          `https://raw.githubusercontent.com/hello-world-1989/json/main/news/${year}/${month}/${day}/${id}.json`
        );

        const res = response?.data;

        if (res?.length > 0) {
          result.push(...res);
        }
      } catch (err: any) {
        console.log('Error loading news data');
      }
    }

    res.send(result);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/news-resource', async (req, res) => {
  try {
    const tempPath = req.url;

    const rawPath = tempPath.replace('/news-resource', '');

    const response = await axios.get(
      `https://raw.githubusercontent.com/hello-world-1989/resource/main${rawPath}`,
      { responseType: 'arraybuffer' }
    );

    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(Buffer.from(response.data, 'binary'));
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/tweet', async (req, res) => {
  try {
    const year = req.query?.year;
    const month = req.query?.month;
    const day = req.query?.day;
    const id = req.query?.id;

    const response = await axios.get(
      `https://raw.githubusercontent.com/hello-world-1989/json/main/tweet/${year}/${month}/${day}/${id}.json`
    );

    res.send(response?.data);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/resource', async (req, res) => {
  try {
    const tempPath = req.url;

    console.log('tempPath: ', tempPath);
    const rawPath = tempPath.replace('/resource', '');

    console.log('path: ', rawPath);

    const response = await axios.get(
      `https://raw.githubusercontent.com/hello-world-1989/resource/main${rawPath}`,
      { responseType: 'arraybuffer' }
    );

    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(Buffer.from(response.data, 'binary'));
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/vpn-data', async (req, res) => {
  try {
    const response = await axios.get('/vpn.json');

    const rawJson = response?.data;

    if (vpnData.length === 0) {
      let ip;

      if (endGFWHosts.length > 0) {
        if (endGFWHosts.length > 2) {
          const today = new Date();
          // Get the day of the month
          const hourOfDay = today.getHours();

          ip = hourOfDay / 2 == 0 ? endGFWHosts?.[0].ip : endGFWHosts?.[1].ip;
        } else {
          ip = endGFWHosts?.[0].ip;
        }

        vpnData = rawJson.map((item) => {
          item.link1 = `http://${ip}/${item.link1}`;

          return item;
        });
      } else {
        vpnData = rawJson;
      }
    }

    res.send(vpnData);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/ee-data', async (req, res) => {
  try {
    const response = await axios.get('/ee.json');

    const rawJson = response?.data;

    if (eeData.length === 0) {
      let ip;

      if (endGFWHosts.length > 0) {
        if (endGFWHosts.length > 2) {
          const today = new Date();
          // Get the day of the month
          const hourOfDay = today.getHours();

          ip = hourOfDay / 2 == 0 ? endGFWHosts?.[0].ip : endGFWHosts?.[1].ip;
        } else {
          ip = endGFWHosts?.[0].ip;
        }

        eeData = rawJson.map((item) => {
          item.link1 = `http://${ip}/${item.link1}`;

          return item;
        });
      } else {
        eeData = rawJson;
      }
    }

    res.send(eeData);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/report', async (req, res) => {
  const ipAddressRes = await axios.get('https://api.ipify.org?format=json');

  let ip = ipAddressRes?.data?.ip;

  if (net.isIPv6(ip)) {
  } else {
    await axios.get(`https://end-gfw.com/node?ip=${ip}&port=${NODE_PORT}`);
  }
});

app.get('/node', async (req, res) => {
  const ip = req.query?.ip;
  const port = req.query?.port;

  try {
    saveMirrorInMemory(ip, port);

    res.send('success');
  } catch (err) {
    console.log(err);
  }
});

async function fetchAPI() {
  const url =
    'https://raw.githubusercontent.com/hello-world-1989/cn-news/main/end-gfw-together';

  if (process.env.NODE_ENV?.includes('dev')) {
    return [];
  }

  const response = await axios.get(url);

  const base64String = response.data;

  const decodedBuffer = Buffer.from(base64String, 'base64');
  const decodedString = decodedBuffer.toString('utf-8');

  const array = decodedString.split('\r\n');

  return array;
}

async function readSSKey() {
  const data = await fs2.readFile(path.join(__dirname, './ssKey.txt'));

  const array = data.toString().split('\n');

  console.log('array:', array);

  return array;
}

async function readHosts() {
  try {
    const data = await fs2.readFile(path.join(__dirname, './hosts.json'));

    const temp1 = JSON.parse(data.toString());

    const temp2 = temp1?.sort((a, b) =>
      a.updatedTime > b.updatedTime ? -1 : 1
    );

    for (const item of temp2) {
      if (hostsMap.has(item.ip)) {
        console.log(`******has ip ${item.ip}`);
      } else {
        const result = await isPortReachable(item.ip, item.port);
        if (result) {
          // temp.push(item);
          hostsMap.set(item.ip, item);
          endGFWHosts.push(item);
        }
      }
    }
  } catch (err) {
    console.error('read hosts file error');
  }
}

async function saveHosts() {
  await fs2.writeFile(
    path.join(__dirname, './hosts.json'),
    JSON.stringify(endGFWHosts)
  );

  console.log('hosts saved');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPortReachable(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.end();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function saveMirrorInMemory(ip, port, extraExpiry = 0) {
  console.log(`*********checking ${ip}`);

  if (hostsMap.has(ip)) {
    console.log(`*********host map has ip: ${ip}`);

    const res = hostsMap.get(ip);

    res.updatedTime = new Date().getTime() + extraExpiry;

    hostsMap.set(ip, res);
  } else {
    let confirmedPort = port;

    const result1 = await isPortReachable(ip, confirmedPort);

    if (result1) {
    } else {
      const result2 = await isPortReachable(ip, 80);

      if (result2) {
        confirmedPort = 80;
      } else {
        console.log(`${ip} is not reachable`);
        return 'fail';
      }
    }

    console.log(`*********${ip} is reachable`);

    const verifyRes = await axios.get(`http://${ip}:${confirmedPort}/youtube`);

    const verifyData = verifyRes.data;

    if (verifyData?.updateTime) {
      console.log(`*********${ip} is able to connect from China`);
      const res = {
        ip,
        port: confirmedPort,
        updatedTime: new Date().getTime() + extraExpiry,
      };

      hostsMap.set(ip, res);
      endGFWHosts.push(res);
    }
  }
}

async function getEndGFWMirror() {
  await readHosts();
  const keyArray = await fetchAPI();

  console.log('keyArray: ', keyArray);

  const ssKeyArray = keyArray?.filter(
    (item) => item.startsWith('ss://') && item.includes('end-gfw')
  );
  // const ssKey2 = keyArray?.[1];

  if (ssKeyArray.length > 0) {
    const ssKey1 = ssKeyArray[ssKeyArray.length - 1];

    const temp1 = ssKey1?.split('@')?.[1];
    // const temp2 = ssKey2?.split('@')?.[1];

    const ip1 = temp1?.split(':')?.[0];
    // const ip2 = temp2?.split(':')?.[0];

    const extraExpiry = new Date().getTime();

    if (process.env.NODE_ENV?.includes('dev')) {
    } else {
      await saveMirrorInMemory(ip1, 8081, extraExpiry);
    }
  }
}

async function periodicCheckConnection() {
  const hosts = Array.from(hostsMap.values());
  const temp: any[] = [];

  const resultArray = hosts?.sort((a, b) =>
    a.updatedTime > b.updatedTime ? -1 : 1
  );

  for (const host of resultArray) {
    const result = await isPortReachable(host.ip, host.port);
    if (result) {
      temp.push(host);
      // allHosts.push(host);
    } else {
      hostsMap.delete(host.ip);
    }
  }

  endGFWHosts = temp;
  saveHosts();
}

setTimeout(periodicCheckConnection, 600000);

getEndGFWMirror();

// Save data to file before shutdown
process.on('SIGINT', async () => {
  console.log('Saving hosts:');
  await saveHosts();

  process.exit(0);
});

app.listen(80, () => console.log(`listening on port 80`));
