#wget https://github.com/hello-world-1989/temp/raw/main/docker-web-v2/install.sh && chmod +x install.sh && sudo sh install.sh

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

ip_address=$(curl -s -4 https://domains.google.com/checkip)

mkdir end-gfw
cd end-gfw

wget https://github.com/hello-world-1989/temp/raw/stable/docker-web-v2/docker-compose.yml

wget https://github.com/hello-world-1989/temp/raw/stable/docker-web-v2/custom.zip

sudo apt install unzip -y

unzip custom.zip

sudo dc up -d

echo "*******************************************************************************************************************************************"
echo "Access End GFW Web http://$ip_address:8081 or http://$ip_address"
echo "Firewall port: 80, 443, 8081"
echo "Disable IPV6"
echo "*******************************************************************************************************************************************"
