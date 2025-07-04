import axios from 'axios';
import express from 'express';
// import * as fs from 'fs';
import * as fs2 from 'node:fs/promises';
import * as path from 'path';
import * as net from 'net';
import { create } from 'express-handlebars';
// import * as https from 'https';

import url from 'url';

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parse } from 'node:path';
import { getAppleId } from './get-apple-id.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const hostsMap = new Map();
let endGFWHosts = [];
const NODE_PORT = process.env.NODE_PORT || 80;
let appleAccount = new Map();

const MASTER_NODE = process.env.MASTER_NODE || false;
const PRIVATE_NODE = process.env.PRIVATE_NODE || false;
const IP_CHECK_HOST = process.env.IP_CHECK_HOST;
const IP_CHECK_REFERER = process.env.IP_CHECK_REFERER;
const IP_CHECK_URL = process.env.IP_CHECK_URL;

const app = express();

const hbs = create({
  // Specify helpers which are only registered on this instance.
  helpers: {
    foo() {
      return 'FOO!';
    },
    mod(a, b) {
      return a % b;
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

app.use('/download-last-7', async (req, res) => {
  try {
    const response = await axios.get(
      `https://github.com/hello-world-1989/latest/releases/download/latest/last7days.pdf`,
      { responseType: 'stream' }
    );

    response.data.pipe(res);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/tweet-page-7', async (req, res) => {
  try {
    let result = [];
    let today = new Date();
    for (var i = 0; i < 3; i++) {
      let dayTemp = new Date(today);
      dayTemp.setDate(dayTemp.getDate() - i);

      let year = '' + dayTemp.getFullYear();
      let month = '' + (dayTemp.getMonth() + 1);
      let day = '' + dayTemp.getDate();

      if (month.length < 2) month = '0' + month;
      if (day.length < 2) day = '0' + day;

      try {
        const response = await axios.get(
          `https://raw.githubusercontent.com/hello-world-1989/json/main/tweet/${year}/${month}/${day}/whyyoutouzhele.json`
        );

        result.push(...response?.data);
      } catch (err) {
        console.error('no data');
      }
    }

    const tweets = result
      ?.sort((a, b) => (a.createdDate > b.createdDate ? -1 : 1))
      .map((item) => {
        const images = item?.images?.split(',') ?? [];

        if (item?.videos) {
          const videoImages = item?.videos?.split(',');
          images.push(...videoImages);
        }

        const nonEmpty = images.filter((item) => item);

        item.allImages = nonEmpty ?? [];

        return item;
      });

    const pdfData = {
      tweets,
    };

    res.render('tweet', pdfData);
  } catch (err) {
    console.log(err);
  }
});

app.get('/tweet-page', async (req, res) => {
  const year = req.query?.year;
  const month = req.query?.month;
  const day = req.query?.day;
  const endDay = req.query?.endDay;
  const id = req.query?.id;

  let url = `https://raw.githubusercontent.com/hello-world-1989/json/main/tweet/${year}`;

  if (month) {
    url += `/${month}`;
  }

  if (day) {
    url += `/${day}`;
  }

  url += `/${id}.json`;

  const sort = (a, b) => {
    if (day) {
      return a.createdDate > b.createdDate ? -1 : 1;
    } else {
      return a.views < b.views ? 1 : -1;
    }
  };

  let result = [];

  try {
    const response = await axios.get(url);
    result = response?.data ?? [];
  } catch (err) {
    console.error('tweet page error', err);
  }

  try {
    if (month && day && endDay) {
      const startDayNumber = parseInt(day);
      const endDayNumber = parseInt(endDay);

      for (let i = startDayNumber + 1; i <= endDayNumber; i++) {
        let endDayStr = i + '';
        if (i < 10) endDayStr = '0' + i;

        try {
          let endDayURL = `https://raw.githubusercontent.com/hello-world-1989/json/main/tweet/${year}/${month}/${endDayStr}/${id}.json`;

          const currentResponse = await axios.get(endDayURL, {
            headers: {
              Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            },
          });

          const currentData = currentResponse?.data ?? [];
          result.push(...currentData);
        } catch (err) {
          console.error('end day error', err);
          continue;
        }
      }
    }
  } catch (err) {
    console.error('end day error', err);
  }

  try {
    const tweets = result
      ?.sort((a, b) => sort(a, b))
      .map((item) => {
        const images = item?.images?.split(',') ?? [];

        if (item?.videos) {
          const videoImages = item.videos?.split(',');
          images.push(...videoImages);
        }

        const nonEmpty = images?.filter((item) => item);

        item.allImages = nonEmpty ?? [];

        return item;
      });

    const pdfData = {
      tweets,
    };

    res.render('tweet', pdfData);
  } catch (err) {
    console.log(err);
  }
});

app.get('/search-tweet-page', async (req, res) => {
  const keyword = req.query?.keyword;

  console.log('keyword', keyword);

  let url = `https://api.github.com/search/code?q=${keyword} in:file repo:hello-world-1989/json`;

  let result = [];

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    });

    result = response?.data;
  } catch (err) {
    console.error('search tweet page err', err);
  }

  const promises = result?.items
    ?.filter((item) => item.name === 'whyyoutouzhele.json')
    .map((item) => {
      let url = `https://raw.githubusercontent.com/hello-world-1989/json/main/${item.path}`;

      const promise = axios.get(url);

      return promise;
    });

  const results = await Promise.all(promises);

  const temp = results.map((item) => item.data);

  const temp1 = temp.flat().filter((item) => item?.content?.includes(keyword));

  const sort = (a, b) => {
    return a.createdDate > b.createdDate ? -1 : 1;
  };

  try {
    const tweets = temp1?.sort(sort).map((item) => {
      const images = item?.images?.split(',') ?? [];

      if (item?.videos) {
        const videoImages = item.videos?.split(',');
        images.push(...videoImages);
      }

      const nonEmpty = images?.filter((item) => item);

      item.allImages = nonEmpty ?? [];

      return item;
    });

    const pdfData = {
      tweets,
    };

    res.render('tweet', pdfData);
  } catch (err) {
    console.log(err);
  }
});

app.get('/news-page', async (req, res) => {
  const year = req.query?.year;
  const month = req.query?.month;
  const day = req.query?.day;
  const sourceId = req.query?.sourceId;
  const newsId = req.query?.newsId;

  try {
    const response = await axios.get(
      `https://raw.githubusercontent.com/hello-world-1989/json/main/news/${year}/${month}/${day}/${sourceId}.json`
    );

    const news = response?.data?.filter((item) => item.id == newsId);

    const newsData = {
      news: news,
    };

    res.render('news', newsData);
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
    // const response = await axios.get(
    //   'https://api.github.com/repos/hello-world-1989/v2-sub/contents/end-gfw-together-ss',
    //   {
    //     headers: {
    //       Authorization: `token ${process.env.GITHUB_TOKEN}`,
    //     },
    //   }
    // );

    const response = await axios.get(process.env.SUB_URL)

    // const base64String = response?.data?.content;
    const base64String = response?.data;

    const decodedBuffer = Buffer.from(base64String, 'base64');

    const decodedString = decodedBuffer.toString('utf-8');



    const array = decodedString.split('\r\n');

    const ssArray = array.filter(item => item.startsWith('ss://'))

    // let result = '';

    // if (array.length > 1) {
    //   const node1 = array?.[0];
    //   const node2 = array?.[1];
    //   result = node1.includes('#kr') ? node1 : node2;
    // } else if (array.length == 1) {
    //   result = array?.[0];
    // }

    res.send(ssArray?.slice(0, 3)?.join('\r\n'));
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

app.use('/host', async (req, res) => {
  try {
    res.send(endGFWHosts.slice(0, 3));
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/apple-account', async (req, res) => {
  try {
    let account;
    if (appleAccount.has('appleId')) {
      account = appleAccount.get('appleId');
    } else {
      let [password, expireDate] = await getAppleId();
      account = {
        username: 'i-eyurbrt@aneeo.cc',
        password,
        expireDate,
      };

      appleAccount.set('appleId', account);
    }
    res.send(account);
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

app.use('/download-pdf', async (req, res) => {
  try {
    const tempPath = req.url;

    const rawPath = tempPath.replace('/download-pdf', '');

    const response = await axios.get(
      `https://github.com/hello-world-1989/whyyoutouzhele/releases/download${rawPath}`,
      { responseType: 'stream' }
    );

    // res.writeHead(200, { 'Content-Type': 'application/zip' });
    // res.end(Buffer.from(response.data, 'binary'));
    response.data.pipe(res);
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

    let result = [];
    const newsSource = ['bbc', 'dw', 'rfa', 'rfi', 'voa'];

    for (const id of newsSource) {
      try {
        const response = await axios.get(
          `https://raw.githubusercontent.com/hello-world-1989/json/main/news/${year}/${month}/${day}/${id}.json`
        );

        const res = response?.data;

        if (res?.length > 0) {
          result.push(...res);
        }
      } catch (err) {
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
    const endDay = req.query?.endDay;
    const id = req.query?.id;

    let url = `https://api.github.com/repos/hello-world-1989/json/contents/tweet/${year}`;

    if (month) {
      url += `/${month}`;
    }

    if (day) {
      url += `/${day}`;
    }

    url += `/${id}.json`;

    let result = [];
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
        },
      });

      let rawResult = response?.data?.content;
      let resultStr = Buffer.from(rawResult, 'base64').toString('utf-8');

      result = JSON.parse(resultStr);

      console.log('result: ', result);

      if (month && day && endDay) {
        const startDayNumber = parseInt(day);
        const endDayNumber = parseInt(endDay);

        for (let i = startDayNumber + 1; i <= endDayNumber; i++) {
          let endDayStr = i + '';
          if (i < 10) endDayStr = '0' + i;

          try {
            let endDayURL = `https://api.github.com/repos/hello-world-1989/json/contents/tweet/${year}/${month}/${endDayStr}/${id}.json`;

            const currentResponse = await axios.get(endDayURL, {
              headers: {
                Authorization: `token ${process.env.GITHUB_TOKEN}`,
              },
            });

            const rawCurrentData = currentResponse?.data?.content ?? [];

            let resultStr = Buffer.from(rawCurrentData, 'base64').toString(
              'utf-8'
            );

            let temp = JSON.parse(resultStr);

            result.push(...temp);
          } catch (err) {
            console.error('end day error', err);
            continue;
          }
        }
      }
    } catch (err) {
      console.error('end day error', err);
    }

    res.send(result);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/event', async (req, res) => {
  try {
    const year = req.query?.year;

    console.log('year', year);

    let url = `https://api.github.com/search/code?q=events in:path repo:hello-world-1989/json`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    });

    const promises = response?.data?.items
      ?.filter((item) => item.path?.includes(year))
      .map((item) => {
        let url = `https://raw.githubusercontent.com/hello-world-1989/json/main/${item.path}`;

        const promise = axios.get(url);

        return promise;
      });

    const results = await Promise.all(promises);

    const temp = results
      .map((item) => item.data)
      .sort((a, b) => a.date - b.date);

    res.send(temp);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/search-tweet', async (req, res) => {
  try {
    const keyword = req.query?.keyword;

    console.log('keyword', keyword);

    let url = `https://api.github.com/search/code?q=${keyword} in:file repo:hello-world-1989/json`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    });

    const promises = response?.data?.items
      ?.filter((item) => item.name === 'whyyoutouzhele.json')
      .map((item) => {
        let url = `https://api.github.com/repos/hello-world-1989/json/contents/${item.path}`;

        const promise = axios.get(url, {
          headers: {
            Authorization: `token ${process.env.GITHUB_TOKEN}`,
          },
        });

        return promise;
      });

    const results = await Promise.all(promises);

    const temp = results.map((item) => {
      const base64String = item?.data?.content;
      const decodedBuffer = Buffer.from(base64String, 'base64');
      const decodedString = decodedBuffer.toString('utf-8');

      return JSON.parse(decodedString);
    });

    const temp1 = temp
      .flat()
      .filter((item) => item?.content?.includes(keyword));

    res.send(temp1);
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
      `https://api.github.com/repos/hello-world-1989/resource/contents${rawPath}`,
      {
        headers: {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
        },
      }
    );

    let base64String = response?.data?.content;
    const decodedBuffer = Buffer.from(base64String, 'base64');

    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(decodedBuffer);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/vpn-data', async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.github.com/repos/hello-world-1989/temp/contents/public/temp/vpn.json',
      {
        headers: {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
        },
      }
    );

    const base64String = response?.data?.content;
    const decodedBuffer = Buffer.from(base64String, 'base64');
    const decodedString = decodedBuffer.toString('utf-8');
    const result = JSON.parse(decodedString);

    res.send(result);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/download-app', async (req, res) => {
  try {
    const tempPath = req.url;

    const rawPath = tempPath.replace('/download-app', '');

    const response = await axios.get(
      `https://github.com/hello-world-1989/temp/releases/download${rawPath}`,
      { responseType: 'stream' }
    );

    // res.writeHead(200, { 'Content-Type': 'application/zip' });
    // res.end(Buffer.from(response.data, 'binary'));
    response.data.pipe(res);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/ee-data', async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.github.com/repos/hello-world-1989/temp/contents/ee.json',
      {
        headers: {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
        },
      }
    );

    const base64String = response?.data?.content;
    const decodedBuffer = Buffer.from(base64String, 'base64');
    const decodedString = decodedBuffer.toString('utf-8');
    const result = JSON.parse(decodedString);

    res.send(result);
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/report', async (req, res) => {
  console.log('master node: ', MASTER_NODE);

  if (MASTER_NODE == 'true') {
    res.send('success');
  } else {
    await report();
    res.send('success');
  }
});

app.use('/node', async (req, res) => {
  const ip = req.query?.ip;
  const port = req.query?.port;

  try {
    saveMirrorInMemory(ip, port, 0, false);

    res.send('success');
  } catch (err) {
    console.log(err);
  }
});

app.use('/renew-plan', async (req, res) => {
  const token = req.query?.token;

  const RENEW_PLAN_URL = process.env.RENEW_PLAN_URL;

  try {
    const response = await axios.get(`${RENEW_PLAN_URL}?token=${token}`);
  } catch (err) {
    console.error('renew plan error', err);
  }

  res.send('success');
});

app.use('/check-status', async (req, res) => {
  try {
    const result = await isPortReachable('baidu.com', 80, 3000);

    res.send(result);
  } catch (err) {
    console.log(err);
    res.send(false);
  }
});

app.use('/ip-check', async (req, res) => {
  try {
    let ipAddress = req.query?.ip;
    const port = req.query?.port ?? 80;

    const result = await ipCheck(ipAddress, port);

    console.log('IP Address:', `${ipAddress}:${port} is ${result}`);

    res.send({
      status: result,
    });
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/url-check/*', async (req, res) => {
  try {
    const rawURL = req.params[0];

    const parsedUrl = new URL(rawURL);

    const hostname = parsedUrl.hostname;

    let port = 80;

    if (parsedUrl?.port) {
      port = parsedUrl?.port;
    } else {
      port = rawURL.startsWith('http://') ? 80 : 443;
    }

    // const port = parsedUrl?.port ??

    console.log('hostname: ', hostname);
    console.log('port: ', port);

    const result = await ipCheck(hostname, port);

    console.log('URL:', `${rawURL}:${port} is ${result}`);

    res.send({
      status: result,
    });
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

//TODO

app.use('/temp/image', async (req, res) => {
  try {
    const rawPath = req.url;

    console.log('path: ', rawPath);

    const response = await axios.get(
      `https://api.github.com/repos/hello-world-1989/cn-news/contents/temp/image${rawPath}`,
      // { responseType: 'arraybuffer' },
      {
        headers: {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
        },
      }
    );

    console.log('response: ', response.data);

    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(Buffer.from(response.data, 'binary'));
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

app.use('/temp/video', async (req, res) => {
  try {
    const rawPath = req.url;

    const response = await axios.get(
      `https://raw.githubusercontent.com/hello-world-1989/cn-news/main/temp/video${rawPath}`,
      { responseType: 'arraybuffer' }
    );

    res.writeHead(200, { 'Content-Type': 'image/jpeg' });

    res.end(Buffer.from(response.data, 'binary'));
  } catch (err) {
    console.log(err);
    res.send('');
  }
});

async function fetchAPI() {
  const url =
    'https://api.github.com/repos/hello-world-1989/cn-news/contents/end-gfw-together-ss';

  if (process.env.NODE_ENV?.includes('dev')) {
    return [];
  }

  let result = [];

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    });

    const base64String = response?.data?.content;

    console.log('base64String: ', base64String);

    const decodedBuffer = Buffer.from(base64String, 'base64');
    const decodedString = decodedBuffer.toString('utf-8');

    console.log('decodedString: ', decodedString);

    const array = decodedString.split('\r\n');

    result = array;
  } catch (err) {
    console.log('fetchAPI error', err);
  }

  return result;
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

async function saveMirrorInMemory(ip, port, extraExpiry = 0, isReboot = false) {
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

    // const verifyRes = await axios.get(`http://${ip}:${confirmedPort}/youtube`);

    // const verifyData = verifyRes.data;

    // if (verifyData?.updateTime) {
    let result4 = 'unknown';

    if (extraExpiry === 0) {
      try {
        if (isReboot) {
        } else {
          // result4 = await ipCheck(ip, confirmedPort);
        }
      } catch (err) {
        // result4 === 'fail';
      }
    }

    if (result4 === 'fail') {
      console.log('Not able to connect from China');
    } else {
      console.log(`*********${ip} is able to connect from China`);
      const res = {
        ip,
        port: confirmedPort,
        updatedTime: new Date().getTime() + extraExpiry,
      };

      hostsMap.set(ip, res);
      endGFWHosts.push(res);
    }
    // }
  }
}

async function getEndGFWMirror() {
  // await readHosts();
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
      await saveMirrorInMemory(ip1, 8081, extraExpiry, true);
    }
  }
}

async function ipCheck(ipAddress, port) {
  const headers = {
    Host: IP_CHECK_HOST,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:115.0esr) Gecko/20010101 Firefox/115.0esr/9S8eMFpqfT',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    Cookie: '',
    Referer: IP_CHECK_REFERER, // Example authorization header
  };

  if (process.env.NODE_ENV?.includes('dev')) {
    return 'success';
  }

  const url = `${IP_CHECK_URL}/${ipAddress}/${port}`;
  const res = await axios.get(url, { headers });

  return res?.data?.tcp ?? 'fail';
}

async function periodicCheckConnection() {
  const hosts = Array.from(hostsMap.values());
  const temp = [];

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
  // saveHosts();
}

async function periodicCheckReachable() {
  const hosts = Array.from(hostsMap.values());

  const temp = [];

  for (const host of hosts) {
    const result = await ipCheck(host.ip, host.port);
    if (result === 'success') {
      temp.push(host);
    } else {
      hostsMap.delete(host.ip);
    }
  }

  endGFWHosts = temp;

  // saveHosts();
}

async function report() {
  console.log('MASTER_NODE: ', MASTER_NODE);

  if (MASTER_NODE == 'true' || PRIVATE_NODE == 'true') {
  } else {
    const ipAddressRes = await axios.get('https://api.ipify.org?format=json');

    let ip = ipAddressRes?.data?.ip;

    console.log('report ip: ', ip);

    if (net.isIPv6(ip)) {
      res.send('ipv6 is not supported');
    } else {
      try {
        await axios.get(`https://end-gfw.com/node?ip=${ip}&port=${NODE_PORT}`);

        if (JSON.stringify(endGFWHosts)?.includes(ip)) {
        } else {
          const item = { ip, port: NODE_PORT };
          endGFWHosts.push(item);
        }
      } catch (err) {
        console.error('Error report failed');
      }
    }
  }
}

setInterval(periodicCheckConnection, 600000);
setInterval(periodicCheckReachable, 3600000);
setInterval(report, 600000);
setInterval(getEndGFWMirror, 3600000);

getEndGFWMirror();
report();

// Save data to file before shutdown
process.on('SIGINT', async () => {
  console.log('Saving hosts:');
  // await saveHosts();

  process.exit(0);
});

app.listen(80, () => console.log(`listening on port 80`));

// if (MASTER_NODE == 'true') {
//   https
//     .createServer(
//       {
//         key: fs.readFileSync(path.join(__dirname, './key.pem')),
//         cert: fs.readFileSync(path.join(__dirname, './cert.pem')),
//       },
//       app
//     )
//     .listen(443, () => console.log(`listening on port 443`));
// }
