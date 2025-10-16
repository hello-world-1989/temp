# 以AWS Lightsail Ubuntu 为例 部署 Xrayr VPN 翻墙软件 和 网站, 建议1GB内存2T流量以上

### [注册AWS教程](https://docs.google.com/document/d/1xXqXkddCLLr8hHz8G8m7b4JHyxWuYiey7h_14pnCGrY/edit?usp=sharing)

### [Vultr教程](https://github.com/hello-world-1989/temp/blob/main/share/vultr.pdf)

 1. 一步搭建， 安装 Docker, Docker-compose, 下载 xrayr 和 web 运行文件

```
wget -O install.sh https://github.com/hello-world-1989/temp/raw/main/docker-xrayr/install.sh && chmod +x install.sh && sudo sh install.sh

```

自定义 赞助商菜单， 请参考

https://github.com/hello-world-1989/temp/blob/main/Custom.md

get docker compose file

#echo YOUR_GITHUB_TOKEN | sudo docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

   
2. `cd ~/end-gfw && sudo dc up -d && sudo dc ps` 应该能看到 Up 状态, 如果不能， `sudo dc logs` 查看日志发送到[电报群](https://t.me/end_gfw1)

3. 防火墙放开 80, 443, 8081, 8880, 8886, 8888 (AWS联网自定义规则中8081,8880,8886,8888 可以简写为 8000-9000) 端口, 禁用 IPV6

5. 访问 http://公共IPV4地址:8081 确认是否搭建成功, 将会自动上报到end-gfw.com网站

6. 查看订阅链接 sub.txt

   ```
   cat ~/end-gfw/sub.txt
   ```
7. 更新 

### 2024.4.12大版本更新

更新方法

```
cd end-gfw

wget -O docker-compose.yml https://github.com/hello-world-1989/temp/raw/main/docker-xrayr/docker-compose.yml

sudo dc pull
sudo dc down
sudo dc up -d
```

