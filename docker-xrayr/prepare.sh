sudo apt install unzip -y
wget https://github.com/hello-world-1989/temp/raw/stable/docker-xrayr/config.zip
wget https://github.com/hello-world-1989/temp/raw/stable/docker-xrayr/docker-compose.yml

unzip config.zip

token=$(uuidgen)

sed -i "s/your-uuid-token/$token/g" ./config/config.yml

echo "*******************************************************************************************************************************************"
echo "Your V2Ray/Outline subscribe URL, also stored in sub.txt" 
echo "https://t5uxwur5pwqcpcm4jifn2hlnm40mcrow.lambda-url.us-east-1.on.aws/api/v1/client/subscribe?token=$token"
echo "https://t5uxwur5pwqcpcm4jifn2hlnm40mcrow.lambda-url.us-east-1.on.aws/api/v1/client/subscribe?token=$token" > sub.txt
echo "Firewall port: 80, 443, 8081, 8880, 8886, 8888"
echo "Disable IPV6"
echo "*******************************************************************************************************************************************"
echo "sudo dc up -d"
echo "*******************************************************************************************************************************************"