import axios from 'axios';
import FormData from 'form-data';

export async function getAppleId() {
  const formData = new FormData();
  formData.append('password_key', '9534726');
  const res = await axios.post('https://ios.aneeo.com/book/88.html', formData, {
    headers: {
      ...formData.getHeaders(),
    },
  });

  const htmlString = res.data;
  const passwordRegex = /密码：(.*?)</g;
  const expireDateRegex = /下次处理时间：(.*?)</;
  let password = '';
  let expireDate = '';

  let matches;
  while ((matches = passwordRegex.exec(htmlString)) !== null) {
    const passwordTemp = matches[1];
    if (passwordTemp.startsWith('Aneeo')) {
      password = passwordTemp;
    }
  }

  const match1 = htmlString.match(expireDateRegex);
  if (match1 && match1[1]) {
    expireDate = match1[1];
  }

  return [password, expireDate];
}
