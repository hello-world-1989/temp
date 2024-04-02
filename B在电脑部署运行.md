## 请查看最新 部署方式

### 1. [微软 苹果电脑部署, 附带 家庭路由器 映射方法](https://github.com/hello-world-1989/temp/blob/main/B%E5%9C%A8%E7%94%B5%E8%84%91%E9%83%A8%E7%BD%B2%E8%BF%90%E8%A1%8C-%E5%BE%AE%E8%BD%AF%E8%8B%B9%E6%9E%9C%E7%94%B5%E8%84%91docker.md) 

### 2. [Linux电脑部署, 以AWS lightsail Ubuntu为例](https://github.com/hello-world-1989/temp/blob/main/B%E5%9C%A8%E7%94%B5%E8%84%91%E9%83%A8%E7%BD%B2%E8%BF%90%E8%A1%8C-linux-docker.md)


## 以下是旧的部署方法

1. [下载并安装 NodeJS](https://nodejs.org/en/download/current)
   
2. [下载并安装 Git](https://git-scm.com/downloads)

3. 在命令行中运行

   ```npm install --global http-server```


4. [下载拆墙运动工具]

   ```

   sudo apt install ffmpeg -y
   sudo snap install jq
   
   git clone https://github.com/hello-world-1989/temp.git

   cd temp

   git submodule update --init --recursive

   cd android && git checkout main

   sh download.sh
   
   cd ../windows && git checkout main

   sh download.sh

   cd ../mac && git checkout main

   sh download.sh

   cd ../whyyoutouzhele && git checkout main

   cd ../..

   ```
 

5. 在命令行中运行 http-server temp -p 8081 -P https://end-gfw.com/

   ```http-server temp -p 8081 -P https://end-gfw.com/```

   运行在8081端口, -p 80 更改端口为80,
   
   目前 仅支持 8081或 80的展示在end-gfw.com网站上，

   需要先自己访问一下后才会添加到网站上， 1小时内无人访问，将不再显示在网站上(可能会增加到5小时或8小时)
   
   如果不想被展示在网站上，请使用其它端口，例如8000, 6060等

   ```

   #Linux后台运行

   http-server temp -p 8081 -P https://end-gfw.com/ &

   #Linux开机自启动

   echo "http-server temp -p 8081 -P https://end-gfw.com/ &" > server.sh

   chmod 777 server.sh
 
   #添加到 /etc/crontab 中

   sudo sh -c 'echo "@reboot ubuntu sudo /bin/sh /home/ubuntu/server.sh" >> /etc/crontab'

   ```

   在浏览器中访问 http://localhost:8081即可， 或者公共ip 地址 http://ip:8081

7. 替换 end-gfw-together 为你的子域名， 这样其他人就能够访问， [也可以通过家庭路由器端口映射实现IP地址访问](https://zhuanlan.zhihu.com/p/43233032)

   ```

   npm install -g localtunnel

   lt --port 8081 -s end-gfw-together

   ```
8. 访问 https://end-gfw-together.loca.lt, 注意替换end-gfw-together为你的子域名, 密码为你的公共IP地址, [查看密码](https://loca.lt/mytunnelpassword)

注意: 人在海外才可以，人在墙内部署运行有风险
如果有更新 需要在  temp 文件夹中运行

```

git config pull.rebase true && git pull

cd android && git pull
   
cd ../windows && git pull

cd ../mac && git pull

cd ../whyyoutouzhele && git pull

```

家庭路由器端口映射，只需要在家庭路由器中添加一条记录即可

大概步骤

1. 登录家庭路由器， 地址一般为192.168.1.1或 192.168.0.1等

2. 添加 NAT记录或路由规则或防火墙规则或端口映射等

3. 内网端口 填写以上8081， 内网地址 填写 本电脑IP地址， 外网端口填写 8081或 8888等

4. 百度搜索 我的IP地址， http://我的IP地址:8081， 这样其它人就可以通过这个地址来访问
