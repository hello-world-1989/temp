1. [下载并安装 NodeJS](https://nodejs.org/en/download/current)
   
2. [下载并安装 Git](https://git-scm.com/downloads)

3. 在命令行中运行

   ```npm install --global http-server```


4. [下载拆墙运动工具]

   ```
   cd temp
   
   git clone https://github.com/hello-world-1989/temp.git

   git submodule update --init --recursive

   cd android && git checkout main
   
   cd ../windows && git checkout main

   cd ../mac && git checkout main

   cd ../whyyoutouzhele && git checkout main

   cd ../..

   ```
 

5. 在命令行中运行 http-server temp -p 8080 -P https://end-gfw.com/

   ```http-server temp -P https://end-gfw.com/```

   默认运行在8080端口, -p 3000 更改端口为3000

   在浏览器中访问 http://localhost:8080即可， 或者公共ip 地址 http://ip:8080

6. 端口映射, 替换 end-gfw-together 为你的子域名

   ```

   npm install -g localtunnel

   lt --port 8080 -s end-gfw-together

   ```
7. 访问 https://end-gfw-together.loca.lt, 注意替换end-gfw-together为你的子域名, 密码为你的公共IP地址, [查看密码](https://loca.lt/mytunnelpassword)

注意: 人在海外才可以，人在墙内部署运行有风险
如果有更新 需要在  temp 文件夹中运行

```

git config pull.rebase true && git pull

cd android && git pull
   
cd ../windows && git pull

cd ../mac && git pull

cd ../whyyoutouzhele && git pull

```
