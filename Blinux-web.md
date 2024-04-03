以AWS Lightsail Ubuntu 为例 部署网站

# 建议网站和Xrayr VPN一起部署， 教程

https://github.com/hello-world-1989/temp/blob/main/Axrayr-web.md

## 仅部署网站
 1. 安装 Docker, Docker-compose, 下载 web 运行文件

```
sudo apt-get update
sudo apt-get install \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg-agent \
    software-properties-common -y
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
yes '' | sudo add-apt-repository \
   "deb [arch=amd64] https://download.docker.com/linux/ubuntu \
   $(lsb_release -cs) \
   stable"
sudo apt-get install docker-ce docker-ce-cli containerd.io -y

# 开机启动 docker

sudo systemctl start docker
sudo systemctl enable docker

# 安装Docker-compose

sudo curl -L "https://github.com/docker/compose/releases/download/1.26.1/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/dc
sudo chmod +x /usr/local/bin/dc

# 下载 web 运行文件

mkdir end-gfw
cd end-gfw
wget https://github.com/hello-world-1989/temp/raw/main/docker/docker-compose.yml

```

2. 启动服务

```
sudo dc up -d
```
   
5. `sudo dc ps` 应该能看到 Up 状态, 如果不能， `sudo dc logs` 查看日志发送到[电报群](https://t.me/end_gfw1)

6. 防火墙放开 80, 8081 端口, 禁用 IPV6

7. http://公共IPV4地址:8081, 需要访问下确认能打开，才会显示在网站上
