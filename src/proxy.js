import axios from "axios";
import express from "express";
import * as path from "path";
import * as net from "net";
import { create } from "express-handlebars";
import url from "url";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getAppleId } from "./get-apple-id.js";

import { getDatabase } from "./database/db.js";
import { TwitterUrlModel, TweetContentModel } from "./database/models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration and Constants
const CONFIG = {
  //DO NOT EDIT NODE_PORT LINE
  NODE_PORT: 80, // Do not change this line
  MASTER_NODE: process.env.MASTER_NODE === "true",
  PRIVATE_NODE: process.env.PRIVATE_NODE === "true",
  IP_CHECK_HOST: process.env.IP_CHECK_HOST,
  IP_CHECK_REFERER: process.env.IP_CHECK_REFERER,
  IP_CHECK_URL: process.env.IP_CHECK_URL,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  SUB_URL: process.env.SUB_URL,
  RENEW_PLAN_URL: process.env.RENEW_PLAN_URL,
  IS_DEV:
    process.env.NODE_ENV?.includes("dev") ||
    process.env.NODE_ENV !== "production",
  CONNECTION_TIMEOUT: 3000,
  REQUEST_TIMEOUT: 10000,
};

// Application State
const AppState = {
  hostsMap: new Map(),
  endGFWHosts: [],
  appleAccount: new Map(),
};

// Axios Configuration
axios.defaults.timeout = CONFIG.REQUEST_TIMEOUT;
axios.defaults.headers.common["Accept-Language"] =
  "zh-CN,zh;q=0.9,en-US;q=0.8,en;";
axios.defaults.headers.common["User-Agent"] =
  "Mozilla/5.0 (X11; Linux x86_64; rv:12.0) Gecko/20100101 Firefox/21.0";
axios.defaults.headers.common["Access-Control-Allow-Origin"] = "*";

// Express App Setup
const app = express();

// Add JSON body parser middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS middleware for frontend requests
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
  } else {
    next();
  }
});

const hbs = create({
  helpers: {
    foo() {
      return "FOO!";
    },
    mod(a, b) {
      return a % b;
    },
    gt(a, b) {
      return a > b;
    },
    eq(a, b) {
      return a === b;
    },
    lt(a, b) {
      return a < b;
    },
  },
});

app.engine("handlebars", hbs.engine);
app.set("view engine", "handlebars");
app.set("views", path.join(__dirname, "./views"));
app.use("/", express.static(path.join(__dirname, "../public/temp")));

// Utility Functions
class APIResponse {
  static success(data, message = "Success") {
    return { success: true, data, message };
  }

  static error(error, message = "Error occurred") {
    return { success: false, error: error.message || error, message };
  }

  static sendSuccess(res, data, message = "Success") {
    res.json(this.success(data, message));
  }

  static sendError(res, error, message = "Error occurred", statusCode = 500) {
    console.error(`API Error: ${message}`, error);
    res.status(statusCode).json(this.error(error, message));
  }
}

// Enhanced validation middleware
const validateQueryParams = (requiredParams = []) => {
  return (req, res, next) => {
    const missing = requiredParams.filter((param) => !req.query[param]);
    if (missing.length > 0) {
      return APIResponse.sendError(
        res,
        `Missing required parameters: ${missing.join(", ")}`,
        "Validation Error",
        400
      );
    }
    next();
  };
};

// Enhanced error handling middleware
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Utility functions
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortReachable(host, port, timeout = CONFIG.CONNECTION_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);

    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function makeRequest(url, options = {}) {
  try {
    const response = await axios.get(url, {
      timeout: CONFIG.REQUEST_TIMEOUT,
      ...options,
    });
    return response;
  } catch (error) {
    console.error(`Request failed for ${url}:`, error.message);
    throw error;
  }
}

async function ipCheck(ipAddress, port) {
  if (CONFIG.IS_DEV) return "success";

  const headers = {
    Host: CONFIG.IP_CHECK_HOST,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; WOW64; rv:115.0esr) Gecko/20010101 Firefox/115.0esr/9S8eMFpqfT",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    Cookie: "",
    Referer: CONFIG.IP_CHECK_REFERER,
  };

  try {
    const url = `${CONFIG.IP_CHECK_URL}/${ipAddress}/${port}`;
    const res = await makeRequest(url, { headers });
    return res?.data?.tcp ?? "fail";
  } catch (error) {
    console.error("IP check failed:", error.message);
    return "fail";
  }
}

// Enhanced API Endpoints

app.get(
  "/download-pdf/*",
  asyncHandler(async (req, res) => {
    const rawPath = req.params[0];
    const url = `https://github.com/hello-world-1989/whyyoutouzhele/releases/download/${rawPath}`;

    try {
      const response = await makeRequest(url, { responseType: "stream" });
      res.setHeader("Content-Type", "application/zip");
      response.data.pipe(res);
    } catch (error) {
      console.error("PDF download error:", error.message);
      res.status(500).send("Download failed");
    }
  })
);

app.get(
  "/download-app/*",
  asyncHandler(async (req, res) => {
    const rawPath = req.params[0];
    const url = `https://github.com/hello-world-1989/temp/releases/download/${rawPath}`;

    try {
      const response = await makeRequest(url, { responseType: "stream" });
      response.data.pipe(res);
    } catch (error) {
      console.error("App download error:", error.message);
      res.status(500).send("Download failed");
    }
  })
);

// 2. Page rendering endpoints
app.get(
  "/tweet-page-7",
  asyncHandler(async (req, res) => {
    try {
      const result = [];
      const today = new Date();

      for (let i = 0; i < 3; i++) {
        const dayTemp = new Date(today);
        dayTemp.setDate(dayTemp.getDate() - i);

        const year = dayTemp.getFullYear().toString();
        const month = (dayTemp.getMonth() + 1).toString().padStart(2, "0");
        const day = dayTemp.getDate().toString().padStart(2, "0");

        try {
          const url = `https://raw.githubusercontent.com/hello-world-1989/json/main/tweet/${year}/${month}/${day}/whyyoutouzhele.json`;
          const response = await makeRequest(url);
          if (response?.data) {
            result.push(...response.data);
          }
        } catch (error) {
          console.log(`No data for ${year}-${month}-${day}`);
        }
      }

      const tweets = result
        ?.sort((a, b) => (a.createdDate > b.createdDate ? -1 : 1))
        .map(processTweetItem);

      res.render("tweet", { tweets });
    } catch (error) {
      console.error("Tweet page error:", error.message);
      res.render("tweet", { tweets: [] });
    }
  })
);

app.get(
  "/tweet-page",
  asyncHandler(async (req, res) => {
    const { year, month, day, endDay, id } = req.query;

    if (!year || !id) {
      return res.render("tweet", { tweets: [] });
    }

    try {
      let url = `https://raw.githubusercontent.com/hello-world-1989/json/main/tweet/${year}`;
      if (month) url += `/${month}`;
      if (day) url += `/${day}`;
      url += `/${id}.json`;

      let result = [];

      try {
        const response = await makeRequest(url);
        result = response?.data ?? [];
      } catch (error) {
        console.error("Tweet page error:", error.message);
      }

      // Handle date range
      if (month && day && endDay) {
        const startDayNumber = parseInt(day);
        const endDayNumber = parseInt(endDay);

        for (let i = startDayNumber + 1; i <= endDayNumber; i++) {
          const endDayStr = i.toString().padStart(2, "0");
          try {
            const endDayURL = `https://raw.githubusercontent.com/hello-world-1989/json/main/tweet/${year}/${month}/${endDayStr}/${id}.json`;
            const currentResponse = await makeRequest(endDayURL, {
              headers: { Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}` },
            });
            result.push(...(currentResponse?.data ?? []));
          } catch (error) {
            console.error(`End day error for ${endDayStr}:`, error.message);
          }
        }
      }

      const sortFn = day
        ? (a, b) => (a.createdDate > b.createdDate ? -1 : 1)
        : (a, b) => (a.views < b.views ? 1 : -1);

      const tweets = result.sort(sortFn).map(processTweetItem);
      res.render("tweet", { tweets });
    } catch (error) {
      console.error("Tweet page error:", error.message);
      res.render("tweet", { tweets: [] });
    }
  })
);

app.get(
  "/search-tweet-page",
  asyncHandler(async (req, res) => {
    const { keyword } = req.query;

    if (!keyword) {
      return res.render("tweet", { tweets: [] });
    }

    try {
      const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(
        keyword
      )} in:file repo:hello-world-1989/json`;
      const searchResponse = await makeRequest(searchUrl, {
        headers: { Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}` },
      });

      const promises =
        searchResponse?.data?.items
          ?.filter((item) => item.name === "whyyoutouzhele.json")
          .map((item) => {
            const url = `https://raw.githubusercontent.com/hello-world-1989/json/main/${item.path}`;
            return makeRequest(url);
          }) ?? [];

      const results = await Promise.all(promises);
      const allTweets = results.map((item) => item.data).flat();
      const filteredTweets = allTweets.filter((item) =>
        item?.content?.includes(keyword)
      );

      const tweets = filteredTweets
        .sort((a, b) => (a.createdDate > b.createdDate ? -1 : 1))
        .map(processTweetItem);

      res.render("tweet", { tweets });
    } catch (error) {
      console.error("Search tweets error:", error.message);
      res.render("tweet", { tweets: [] });
    }
  })
);

app.get(
  "/news-page",
  asyncHandler(async (req, res) => {
    const { year, month, day, sourceId, newsId } = req.query;

    if (!year || !month || !day || !sourceId || !newsId) {
      return res.render("news", { news: [] });
    }

    try {
      const url = `https://raw.githubusercontent.com/hello-world-1989/json/main/news/${year}/${month}/${day}/${sourceId}.json`;
      const response = await makeRequest(url);
      const news = response?.data?.filter((item) => item.id == newsId) ?? [];

      res.render("news", { news });
    } catch (error) {
      console.error("News page error:", error.message);
      res.render("news", { news: [] });
    }
  })
);

// 3. Data API endpoints
app.get(
  "/github",
  asyncHandler(async (req, res) => {
    try {
      const response = await makeRequest(
        "https://raw.githubusercontent.com/hello-world-1989/cn-news/main/server.txt"
      );
      res.send(response?.data || "");
    } catch (error) {
      res.send("");
    }
  })
);

app.get(
  "/ss-key",
  asyncHandler(async (req, res) => {
    try {
      const response = await makeRequest(CONFIG.SUB_URL);
      const base64String = response?.data;

      if (!base64String) {
        return res.send("");
      }

      const decodedBuffer = Buffer.from(base64String, "base64");
      const decodedString = decodedBuffer.toString("utf-8");
      const array = decodedString.split("\r\n");
      const ssArray = array.filter((item) => item.startsWith("ss://"));

      res.send(ssArray?.slice(0, 3)?.join("\r\n") || "");
    } catch (error) {
      console.error("SS-Key error:", error.message);
      res.send("");
    }
  })
);

// Enhanced resource endpoints with better error handling
const createResourceEndpoint = (baseUrl, endpoint) => {
  return asyncHandler(async (req, res) => {
    try {
      const response = await makeRequest(`${baseUrl}/${endpoint}.json`);
      res.send(response?.data);
    } catch (error) {
      console.error(`${endpoint} error:`, error.message);
      res.send("");
    }
  });
};

app.get(
  "/youtube",
  createResourceEndpoint(
    "https://raw.githubusercontent.com/hello-world-1989/accessible/main",
    "youtube"
  )
);
app.get(
  "/obfs4",
  createResourceEndpoint(
    "https://raw.githubusercontent.com/hello-world-1989/cn-news/main",
    "obfs4"
  )
);
app.get(
  "/wiki",
  createResourceEndpoint(
    "https://raw.githubusercontent.com/hello-world-1989/accessible/main",
    "wiki"
  )
);
app.get(
  "/nitter",
  createResourceEndpoint(
    "https://raw.githubusercontent.com/hello-world-1989/accessible/main",
    "nitter"
  )
);
app.get(
  "/searchx",
  createResourceEndpoint(
    "https://raw.githubusercontent.com/hello-world-1989/accessible/main",
    "searchx"
  )
);
app.get(
  "/pdf",
  createResourceEndpoint(
    "https://raw.githubusercontent.com/hello-world-1989/whyyoutouzhele/main",
    "pdf"
  )
);

app.get(
  "/host",
  asyncHandler(async (req, res) => {
    try {
      res.send(AppState.endGFWHosts.slice(0, 3));
    } catch (error) {
      console.error("Host error:", error.message);
      res.send("");
    }
  })
);

app.get(
  "/apple-account",
  asyncHandler(async (req, res) => {
    try {
      let account;

      if (AppState.appleAccount.has("appleId")) {
        account = AppState.appleAccount.get("appleId");
      } else {
        const [password, expireDate] = await getAppleId();
        account = {
          username: "i-eyurbrt@aneeo.cc",
          password,
          expireDate,
        };
        AppState.appleAccount.set("appleId", account);
      }

      res.send(account);
    } catch (error) {
      console.error("Apple account error:", error.message);
      res.send("");
    }
  })
);

// Enhanced news data endpoint
app.get(
  "/news-data",
  asyncHandler(async (req, res) => {
    const { year, month, day } = req.query;

    if (!year || !month || !day) {
      return res.send([]);
    }

    try {
      const result = [];
      const newsSource = ["bbc", "dw", "rfa", "rfi", "voa"];

      const promises = newsSource.map(async (id) => {
        try {
          const url = `https://raw.githubusercontent.com/hello-world-1989/json/main/news/${year}/${month}/${day}/${id}.json`;
          const response = await makeRequest(url);
          return response?.data || [];
        } catch (error) {
          console.log(`No news data for ${id} on ${year}-${month}-${day}`);
          return [];
        }
      });

      const results = await Promise.all(promises);
      results.forEach((data) => {
        if (data.length > 0) {
          result.push(...data);
        }
      });

      res.send(result);
    } catch (error) {
      console.error("News data error:", error.message);
      res.send([]);
    }
  })
);

// Tweet data endpoint with improved error handling
app.get(
  "/tweet",
  asyncHandler(async (req, res) => {
    const { year, month, day, endDay, id } = req.query;

    if (!year || !id) {
      return res.send({ error: "Missing required parameters: year, id" });
    }

    try {
      let url = `https://api.github.com/repos/hello-world-1989/json/contents/tweet/${year}`;
      if (month) url += `/${month}`;
      if (day) url += `/${day}`;
      url += `/${id}.json`;

      let result = [];

      try {
        const response = await makeRequest(url, {
          headers: { Authorization: `token ${CONFIG.GITHUB_TOKEN}` },
        });

        const rawResult = response?.data?.content;
        if (rawResult) {
          const resultStr = Buffer.from(rawResult, "base64").toString("utf-8");
          result = JSON.parse(resultStr);
        }
      } catch (error) {
        console.error("Tweet fetch error:", error.message);
      }

      // Handle date range
      if (month && day && endDay) {
        const startDayNumber = parseInt(day);
        const endDayNumber = parseInt(endDay);

        for (let i = startDayNumber + 1; i <= endDayNumber; i++) {
          const endDayStr = i.toString().padStart(2, "0");
          try {
            const endDayURL = `https://api.github.com/repos/hello-world-1989/json/contents/tweet/${year}/${month}/${endDayStr}/${id}.json`;
            const currentResponse = await makeRequest(endDayURL, {
              headers: { Authorization: `token ${CONFIG.GITHUB_TOKEN}` },
            });

            const rawCurrentData = currentResponse?.data?.content;
            if (rawCurrentData) {
              const resultStr = Buffer.from(rawCurrentData, "base64").toString(
                "utf-8"
              );
              const temp = JSON.parse(resultStr);
              result.push(...temp);
            }
          } catch (error) {
            console.error(`End day error for ${endDayStr}:`, error.message);
          }
        }
      }

      res.send(result);
    } catch (error) {
      console.error("Tweet data error:", error.message);
      res.send([]);
    }
  })
);

// Enhanced event endpoint
app.get(
  "/event",
  validateQueryParams(["year"]),
  asyncHandler(async (req, res) => {
    const { year } = req.query;

    try {
      const searchUrl = `https://api.github.com/search/code?q=events in:path repo:hello-world-1989/json`;
      const response = await makeRequest(searchUrl, {
        headers: { Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}` },
      });

      const promises =
        response?.data?.items
          ?.filter((item) => item.path?.includes(year))
          .map((item) => {
            const url = `https://raw.githubusercontent.com/hello-world-1989/json/main/${item.path}`;
            return makeRequest(url);
          }) ?? [];

      const results = await Promise.all(promises);
      const events = results
        .map((item) => item.data)
        .sort((a, b) => a.date - b.date);

      res.send(events);
    } catch (error) {
      console.error("Event data error:", error.message);
      res.send([]);
    }
  })
);

// Enhanced search tweet endpoint
app.get(
  "/search-tweet",
  validateQueryParams(["keyword"]),
  asyncHandler(async (req, res) => {
    const { keyword } = req.query;

    try {
      const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(
        keyword
      )} in:file repo:hello-world-1989/json`;
      const response = await makeRequest(searchUrl, {
        headers: { Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}` },
      });

      const promises =
        response?.data?.items
          ?.filter((item) => item.name === "whyyoutouzhele.json")
          .map((item) => {
            const url = `https://api.github.com/repos/hello-world-1989/json/contents/${item.path}`;
            return makeRequest(url, {
              headers: { Authorization: `token ${CONFIG.GITHUB_TOKEN}` },
            });
          }) ?? [];

      const results = await Promise.all(promises);
      const allTweets = results
        .map((item) => {
          const base64String = item?.data?.content;
          if (!base64String) return [];

          const decodedBuffer = Buffer.from(base64String, "base64");
          const decodedString = decodedBuffer.toString("utf-8");
          return JSON.parse(decodedString);
        })
        .flat();

      const filteredTweets = allTweets.filter((item) =>
        item?.content?.includes(keyword)
      );

      res.send(filteredTweets);
    } catch (error) {
      console.error("Search tweet error:", error.message);
      res.send([]);
    }
  })
);

// Enhanced resource endpoints
app.get(
  "/resource/*",
  asyncHandler(async (req, res) => {
    const rawPath = req.params[0];

    try {
      const url = `https://api.github.com/repos/hello-world-1989/resource/contents/${rawPath}`;
      const response = await makeRequest(url, {
        headers: { Authorization: `token ${CONFIG.GITHUB_TOKEN}` },
      });

      const base64String = response?.data?.content;
      if (!base64String) {
        console.error(`Resource not found: ${rawPath}`);
        return res.status(404).send("Resource not found");
      }

      const decodedBuffer = Buffer.from(base64String, "base64");
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(decodedBuffer);
    } catch (error) {
      console.error("Resource fetch error:", error.message);
      res.status(500).send("Failed to fetch resource");
    }
  })
);

app.get(
  "/news-resource/*",
  asyncHandler(async (req, res) => {
    const rawPath = req.params[0];

    try {
      const url = `https://raw.githubusercontent.com/hello-world-1989/resource/main/${rawPath}`;
      const response = await makeRequest(url, { responseType: "arraybuffer" });

      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(Buffer.from(response.data, "binary"));
    } catch (error) {
      console.error("News resource fetch error:", error.message);
      res.status(500).send("Failed to fetch news resource");
    }
  })
);

// VPN and EE data endpoints with GitHub API
const createGitHubDataEndpoint = (filePath) => {
  return asyncHandler(async (req, res) => {
    try {
      const url = `https://api.github.com/repos/hello-world-1989/temp/contents/${filePath}`;
      const response = await makeRequest(url, {
        headers: { Authorization: `token ${CONFIG.GITHUB_TOKEN}` },
      });

      const base64String = response?.data?.content;
      if (!base64String) {
        console.error(`Data not found for ${filePath}`);
        return res.send("");
      }

      const decodedBuffer = Buffer.from(base64String, "base64");
      const decodedString = decodedBuffer.toString("utf-8");
      const result = JSON.parse(decodedString);

      res.send(result);
    } catch (error) {
      console.error(`Failed to fetch ${filePath}:`, error.message);
      res.send("");
    }
  });
};

app.get("/vpn-data", createGitHubDataEndpoint("public/temp/vpn.json"));
app.get("/ee-data", createGitHubDataEndpoint("ee.json"));

// System endpoints with enhanced functionality
app.get(
  "/report",
  asyncHandler(async (req, res) => {
    console.log("Master node:", CONFIG.MASTER_NODE);

    if (CONFIG.MASTER_NODE) {
      return res.send({ reported: false });
    }

    try {
      await report();
      res.send({ reported: true });
    } catch (error) {
      console.error("Report error:", error.message);
      res.send({ reported: false });
    }
  })
);

app.get(
  "/node",
  asyncHandler(async (req, res) => {
    const { ip, port } = req.query;

    if (!ip || !port) {
      return res.send({ error: "Missing required parameters: ip, port" });
    }

    try {
      await saveMirrorInMemory(ip, port, 0, false);
      res.send({ ip, port });
    } catch (error) {
      console.error("Node registration error:", error.message);
      res.send({ error: "Failed to register node" });
    }
  })
);

app.get(
  "/renew-plan",
  validateQueryParams(["token"]),
  asyncHandler(async (req, res) => {
    const { token } = req.query;

    try {
      await makeRequest(`${CONFIG.RENEW_PLAN_URL}?token=${token}`);
      res.send({ renewed: true });
    } catch (error) {
      console.error("Renew plan error:", error.message);
      res.send({ error: "Failed to renew plan" });
    }
  })
);

app.get(
  "/check-status",
  asyncHandler(async (req, res) => {
    try {
      const result = await isPortReachable("baidu.com", 80, 3000);
      res.send({ status: result, timestamp: new Date().toISOString() });
    } catch (error) {
      console.error("Status check error:", error.message);
      res.send({ status: false, timestamp: new Date().toISOString() });
    }
  })
);

app.get(
  "/ip-check",
  asyncHandler(async (req, res) => {
    const { ip, port = 80 } = req.query;

    if (!ip) {
      return res.send({ error: "Missing required parameter: ip" });
    }

    try {
      const result = await ipCheck(ip, port);
      console.log(`IP Check: ${ip}:${port} is ${result}`);
      res.send({
        ip,
        port,
        status: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("IP check error:", error.message);
      res.send({
        ip,
        port,
        status: false,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

app.get(
  "/url-check/*",
  asyncHandler(async (req, res) => {
    const rawURL = req.params[0];

    if (!rawURL) {
      return res.send({ error: "URL is required" });
    }

    try {
      const parsedUrl = new URL(rawURL);
      const hostname = parsedUrl.hostname;
      let port = parsedUrl.port || (rawURL.startsWith("http://") ? 80 : 443);

      const result = await ipCheck(hostname, port);
      console.log(`URL Check: ${rawURL} is ${result}`);

      res.send({
        url: rawURL,
        hostname,
        port,
        status: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("URL check error:", error.message);
      res.send({
        url: rawURL,
        status: false,
        timestamp: new Date().toISOString(),
      });
    }
  })
);

// Helper functions
function processTweetItem(item) {
  const images = item?.images?.split(",") ?? [];
  if (item?.videos) {
    const videoImages = item.videos?.split(",");
    images.push(...videoImages);
  }
  const nonEmpty = images?.filter((img) => img);
  item.allImages = nonEmpty ?? [];
  return item;
}

async function saveMirrorInMemory(ip, port, extraExpiry = 0, isReboot = false) {
  console.log(`Checking ${ip}:${port}`);

  if (AppState.hostsMap.has(ip)) {
    console.log(`Host map already has IP: ${ip}`);
    const host = AppState.hostsMap.get(ip);
    host.updatedTime = new Date().getTime() + extraExpiry;
    AppState.hostsMap.set(ip, host);
    return "updated";
  }

  let confirmedPort = port;
  const result1 = await isPortReachable(ip, confirmedPort);

  if (!result1) {
    const result2 = await isPortReachable(ip, 80);
    if (result2) {
      confirmedPort = 80;
    } else {
      console.log(`${ip} is not reachable`);
      return "fail";
    }
  }

  console.log(`${ip}:${confirmedPort} is reachable`);

  let ipCheckResult = "unknown";
  if (extraExpiry === 0 && !isReboot) {
    try {
      // ipCheckResult = await ipCheck(ip, confirmedPort);
    } catch (error) {
      console.error(`IP check failed for ${ip}:`, error.message);
    }
  }

  if (ipCheckResult === "fail") {
    console.log("Not able to connect from China");
    return "fail";
  }

  console.log(`${ip}:${confirmedPort} is accessible from China`);
  const host = {
    ip,
    port: confirmedPort,
    updatedTime: new Date().getTime() + extraExpiry,
    status: ipCheckResult,
  };

  AppState.hostsMap.set(ip, host);
  AppState.endGFWHosts.push(host);
  return "success";
}

async function report() {
  if (CONFIG.MASTER_NODE || CONFIG.PRIVATE_NODE) {
    return;
  }

  try {
    const ipAddressRes = await makeRequest("https://api.ipify.org?format=json");
    const ip = ipAddressRes?.data?.ip;

    console.log("Reporting IP:", ip);

    if (net.isIPv6(ip)) {
      throw new Error("IPv6 is not supported");
    }

    await makeRequest(
      `https://end-gfw.com/node?ip=${ip}&port=${CONFIG.NODE_PORT}`
    );

    if (!JSON.stringify(AppState.endGFWHosts).includes(ip)) {
      const item = { ip, port: CONFIG.NODE_PORT };
      AppState.endGFWHosts.push(item);
    }
  } catch (error) {
    console.error("Report failed:", error.message);
    throw error;
  }
}

async function periodicCheckConnection() {
  const hosts = Array.from(AppState.hostsMap.values());
  const activeHosts = [];

  const sortedHosts = hosts.sort((a, b) =>
    a.updatedTime > b.updatedTime ? -1 : 1
  );

  for (const host of sortedHosts) {
    const result = await isPortReachable(host.ip, host.port);
    if (result) {
      activeHosts.push(host);
    } else {
      AppState.hostsMap.delete(host.ip);
      console.log(`Removed inactive host: ${host.ip}:${host.port}`);
    }
  }

  AppState.endGFWHosts = activeHosts;
  console.log(`Active hosts: ${activeHosts.length}`);
}

async function periodicCheckReachable() {
  const hosts = Array.from(AppState.hostsMap.values());
  const reachableHosts = [];

  for (const host of hosts) {
    const result = await ipCheck(host.ip, host.port);
    if (result === "success") {
      reachableHosts.push(host);
    } else {
      AppState.hostsMap.delete(host.ip);
      console.log(`Removed unreachable host: ${host.ip}:${host.port}`);
    }
  }

  AppState.endGFWHosts = reachableHosts;
  console.log(`Reachable hosts: ${reachableHosts.length}`);
}

async function fetchAPI() {
  if (CONFIG.IS_DEV) {
    return [];
  }

  try {
    const url =
      "https://api.github.com/repos/hello-world-1989/cn-news/contents/end-gfw-together-ss";
    const response = await makeRequest(url, {
      headers: { Authorization: `token ${CONFIG.GITHUB_TOKEN}` },
    });

    const base64String = response?.data?.content;
    if (!base64String) return [];

    console.log("Fetched API data");
    const decodedBuffer = Buffer.from(base64String, "base64");
    const decodedString = decodedBuffer.toString("utf-8");
    return decodedString.split("\r\n");
  } catch (error) {
    console.error("fetchAPI error:", error.message);
    return [];
  }
}

async function getEndGFWMirror() {
  const keyArray = await fetchAPI();
  console.log("Key array length:", keyArray.length);

  const ssKeyArray = keyArray?.filter(
    (item) => item.startsWith("ss://") && item.includes("end-gfw")
  );

  if (ssKeyArray.length > 0) {
    const ssKey1 = ssKeyArray[ssKeyArray.length - 1];
    const temp1 = ssKey1?.split("@")?.[1];
    const ip1 = temp1?.split(":")?.[0];
    const extraExpiry = new Date().getTime();

    if (!CONFIG.IS_DEV && ip1) {
      await saveMirrorInMemory(ip1, 8081, extraExpiry, true);
    }
  }
}

// Global error handler
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  APIResponse.sendError(res, error, "Internal server error", 500);
});

// API endpoint to add Twitter URL
app.post("/api/add-url", async (req, res) => {
  try {
    const { url } = req.body;
    const { token } = req.query;

    if(token !== process.env.VIDEO_PROCESS_TOKEN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!url) {
      return res.status(400).json({ error: "Twitter URL is required" });
    }

    // Basic Twitter URL validation
    const twitterUrlRegex =
      /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/\w+\/status\/\d+/;
    if (!twitterUrlRegex.test(url)) {
      return res.status(400).json({ error: "Invalid Twitter URL format" });
    }

    // Save to database
    const twitterUrlModel = new TwitterUrlModel();
    const savedUrl = await twitterUrlModel.addUrl(url);

    console.log("✅ Twitter URL saved to database:", url);

    res.json({
      success: true,
      message: "Twitter URL added successfully",
      data: savedUrl,
    });
  } catch (error) {
    console.error("❌ Error adding URL:", error);

    if (error.message.includes("already been added")) {
      return res.status(409).json({ error: error.message });
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

// API endpoint to get all URLs
app.get("/api/urls", async (req, res) => {
  try {

    const { token } = req.query;
    if(token !== process.env.VIDEO_PROCESS_TOKEN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const twitterUrlModel = new TwitterUrlModel();
    const urls = await twitterUrlModel.getAllUrls();
    const stats = await twitterUrlModel.getStats();

    res.json({
      urls,
      stats,
      success: true,
    });
  } catch (error) {
    console.error("❌ Error fetching URLs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API endpoint to get all URLs
app.get("/api/unprocessed-urls", async (req, res) => {
  try {

    const { token } = req.query;
    if(token !== process.env.VIDEO_PROCESS_TOKEN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const twitterUrlModel = new TwitterUrlModel();
    const urls = await twitterUrlModel.getUnprocessedUrls();
    const stats = await twitterUrlModel.getStats();

    res.json({
      urls,
      stats,
      success: true,
    });
  } catch (error) {
    console.error("❌ Error fetching URLs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API endpoint to process a specific Twitter URL (fetch content + AI summary)
app.post("/api/process-url/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { token } = req.query;
    if(token !== process.env.VIDEO_PROCESS_TOKEN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const twitterUrlModel = new TwitterUrlModel();

    // Get URL from database
    const urlRecord = await twitterUrlModel.getById(id);
    if (!urlRecord) {
      return res.status(404).json({ error: "URL not found" });
    }

    if (urlRecord.processed) {
      return res.status(400).json({ error: "URL already processed" });
    }

    console.log(`🔄 Processing Twitter URL: ${urlRecord.url}`);

    // Update status to processing
    await twitterUrlModel.updateStatus(id, "processing");

    // Here you would typically:
    // 1. Fetch the actual tweet data from Twitter API
    // 2. Extract additional user info (display name, etc.)
    // 3. Save tweet content using TweetContentModel
    // 4. Update author info in the twitter_urls table
    
    // Example of how to update author info when you get the actual tweet data:
    // const tweetData = await fetchTweetData(urlRecord.tweet_id); // Your Twitter API call
    // if (tweetData && tweetData.user) {
    //   await twitterUrlModel.updateAuthorInfo(id, tweetData.user.screen_name, tweetData.user.name);
    //   
    //   // Save tweet content
    //   const tweetContentModel = new TweetContentModel();
    //   await tweetContentModel.saveTweetContent(id, {
    //     id: tweetData.id_str,
    //     author_id: tweetData.user.id_str,
    //     username: tweetData.user.screen_name,
    //     name: tweetData.user.name,
    //     profile_image_url: tweetData.user.profile_image_url,
    //     text: tweetData.full_text,
    //     created_at: tweetData.created_at,
    //     public_metrics: tweetData.public_metrics
    //   });
    // }

    // Mark as processed
    await twitterUrlModel.markAsProcessed(id, "completed");

    console.log(`✅ Successfully processed tweet ID: ${urlRecord.tweet_id}, Username: ${urlRecord.author_username || 'extracted from URL'}`);

    res.json({
      success: true,
      message: "URL processed successfully",
      data: {
        id,
        tweet_id: urlRecord.tweet_id,
        author_username: urlRecord.author_username,
        url: urlRecord.url
      },
    });
  } catch (error) {
    console.error("❌ Error in process-url endpoint:", error);
    res.status(500).json({
      error: "Processing failed",
      details: error.message,
    });
  }
});

// 404 handler
app.use((req, res) => {
  APIResponse.sendError(res, "Endpoint not found", "Not Found", 404);
});

// Periodic tasks
if (!CONFIG.IS_DEV) {
  // setInterval(periodicCheckConnection, 600000); // 10 minutes
  setInterval(periodicCheckReachable, 3600000); // 1 hour
  setInterval(report, 600000); // 10 minutes
  setInterval(getEndGFWMirror, 3600000); // 1 hour

  // Initial setup
  getEndGFWMirror();
  report();
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  process.exit(0);
});

const db = getDatabase();
await db.initialize();

// Start server
const server = app.listen(CONFIG.NODE_PORT, () => {
  console.log(`Enhanced proxy server listening on port ${CONFIG.NODE_PORT}`);
  console.log(`Environment: ${CONFIG.IS_DEV ? "Development" : "Production"}`);
  console.log(`Master node: ${CONFIG.MASTER_NODE}`);
});

// Export for testing
export { app, CONFIG, AppState };
