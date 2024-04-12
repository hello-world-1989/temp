以AWS Lightsail Ubuntu 为例 部署网站

# 建议网站和Xrayr VPN一起部署， 教程

https://github.com/hello-world-1989/temp/blob/main/Axrayr-web.md

自定义赞助商菜单，请参考

https://github.com/hello-world-1989/temp/blob/main/Custom.md

## 仅部署网站
 1. 一步搭建安装 Docker, Docker-compose, 下载 web 运行文件

```
wget https://github.com/hello-world-1989/temp/raw/stable/docker-web-v2/install.sh && chmod +x install.sh && sudo sh install.sh

```
   
2. `cd ~/end-gfw && sudo dc ps` 应该能看到 Up 状态, 如果不能， `sudo dc logs` 查看日志发送到[电报群](https://t.me/end_gfw1)

3. 防火墙放开 80, 8081 端口, 禁用 IPV6

4. 访问 http://公共IPV4地址:8081 确认是否搭建成功, 将会自动上报到end-gfw.com网站

5. 更新 

### 2024.4.12大版本更新

更新方法

```
cd ~/end-gfw

wget -O docker-compose.yml https://github.com/hello-world-1989/temp/raw/stable/docker-web-v2/docker-compose.yml

sudo dc pull
sudo dc down
sudo dc up -d
```

