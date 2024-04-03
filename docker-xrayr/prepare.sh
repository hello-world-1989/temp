sudo apt install unzip -y
wget https://github.com/hello-world-1989/temp/raw/main/docker-xrayr/config.zip

unzip config.zip

token=$(uuidgen)

sed -i "s/your-uuid-token/$(token)/g" ./config/config.yml

echo "*******************************************************************************************************************************************"
echo "Your V2Ray/Outline subscribe URL: https://t5uxwur5pwqcpcm4jifn2hlnm40mcrow.lambda-url.us-east-1.on.aws/api/v1/client/subscribe?token=$(token)" 
echo "Your V2Ray/Outline subscribe URL: https://t5uxwur5pwqcpcm4jifn2hlnm40mcrow.lambda-url.us-east-1.on.aws/api/v1/client/subscribe?token=$(token)" > sub.txt
echo "Firewall port: 80, 443, 8081, 8880, 8886, 8888"
echo "Disable IPV6"
echo "*******************************************************************************************************************************************"
echo "sudo dc up -d to run"
echo "*******************************************************************************************************************************************"
echo "sudo dc logs to check logs"
echo "sudo dc ps to check status"
echo "*******************************************************************************************************************************************"
