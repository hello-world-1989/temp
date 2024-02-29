1. [下载并安装 NodeJS](https://nodejs.org/en/download/current)

2. 在命令行中运行

   ```npm install --global http-server```


3. [下载拆墙运动工具]

   ```git clone https://github.com/hello-world-1989/temp.git```

   ```git submodule update --init --recursive```

   ```cd android && git pull https://github.com/hello-world-1989/android.git main```
   
   ```cd windows && git pull https://github.com/hello-world-1989/windows.git main```

   ```cd mac && git pull https://github.com/hello-world-1989/mac.git main```

   ```cd ../..```
 

5. 在命令行中运行 http-server 拆墙运动工具文件夹 -p 8080 -P https://end-gfw.com/

   ```http-server temp -P https://end-gfw.com/```

   默认运行在8080端口, -p 3000 更改端口为3000

   在浏览器中访问 http://localhost:8080即可， 或者公共ip 地址 http://ip:8080

注意: 人在海外才可以，人在墙内部署运行有风险
如果有更新 需要在  temp 文件夹中运行 `git config pull.rebase true && git pull`
