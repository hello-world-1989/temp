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

sudo apt install unzip -y
wget https://github.com/hello-world-1989/temp/raw/stable/docker-xrayr/config.zip
wget https://github.com/hello-world-1989/temp/raw/stable/docker-xrayr/docker-compose.yml

unzip config.zip

token=$(uuidgen)

sed -i "s/your-uuid-token/$token/g" ./config/config.yml

sudo dc up -d

echo "*******************************************************************************************************************************************"
echo "Your V2Ray/Outline subscribe URL, also stored in sub.txt" 
echo "https://t5uxwur5pwqcpcm4jifn2hlnm40mcrow.lambda-url.us-east-1.on.aws/api/v1/client/subscribe?token=$token"
echo "https://t5uxwur5pwqcpcm4jifn2hlnm40mcrow.lambda-url.us-east-1.on.aws/api/v1/client/subscribe?token=$token" > sub.txt
echo "Firewall port: 80, 443, 8081, 8880, 8886, 8888"
echo "Disable IPV6"
echo "*******************************************************************************************************************************************"
