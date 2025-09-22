import axios from 'axios';

const APPLE_ID_URL = process.env.APPLE_ID_URL;

export async function getAppleId() {
  const res = await axios.get(APPLE_ID_URL);

  const resData = res.data;

  console.log('resData: ', resData);
  //   const passwordRegex = /密码：(.*?)</;
  let username = resData?.[0]?.username;
  let password = resData?.[0]?.password;
  let expireDate = resData?.[0]?.time;

  console.log('Success:', username, password, expireDate);

  return [username, password, expireDate];
  //   console.log('Success:', htmlString);
}

// getAppleId();
