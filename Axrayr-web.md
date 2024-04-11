# 以AWS Lightsail Ubuntu 为例 部署 Xrayr VPN 翻墙软件 和 网站, 建议1GB内存2T流量以上

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
wget https://github.com/hello-world-1989/temp/raw/stable/docker-xrayr/prepare.sh
chmod +x prepare.sh
sh prepare.sh

```

2. 启动服务

```
sudo dc up -d
```
   
3. `sudo dc ps` 应该能看到 Up 状态, 如果不能， `sudo dc logs` 查看日志发送到[电报群](https://t.me/end_gfw1)

4. 防火墙放开 80, 443, 8081, 8880, 8886, 8888 (AWS联网自定义规则中8081,8880,8886,8888 可以简写为 8000-9000) 端口, 禁用 IPV6

5. 访问 http://公共IPV4地址:8081 确认是否搭建成功

6. 访问 http://公共IPV4地址:8081/report 将上报并展示在end-gfw网站上

7. 查看订阅链接 sub.txt

   ```
   cat sub.txt
   ```
8. 更新 

### 小版本更新，重启服务器即可

### 2024.4.11大版本更新

更新方法

```
cd end-gfw

wget -O docker-compose.yml https://github.com/hello-world-1989/temp/raw/stable/docker-xrayr/docker-compose.yml

sudo dc pull
sudo dc down
sudo dc up -d
```

