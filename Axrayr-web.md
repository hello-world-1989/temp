# 以AWS Lightsail Ubuntu 为例 部署 Xrayr VPN 翻墙软件 和 网站

 1. 安装 Docker, Docker-compose, 下载 xrayr 和 web 运行文件

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

# 下载 xrayr 和 web 运行文件

mkdir end-gfw
cd end-gfw
wget https://github.com/hello-world-1989/temp/raw/main/docker-xrayr/prepare.sh
chmod +x prepare.sh
sh prepare.sh

```

2. 启动服务

```
sudo dc up -d
```
   
3. `sudo dc ps` 应该能看到 Up 状态, 如果不能， `sudo dc logs` 查看日志发送到[电报群](https://t.me/end_gfw1)

4. 防火墙放开 80, 443, 8081, 8880, 8886, 8888(AWS联网自定义规则中可以写为 8000-9000) 端口, 禁用 IPV6

5. http://公共IPV4地址:8081, 需要访问下确认能打开，才会显示在网站上
