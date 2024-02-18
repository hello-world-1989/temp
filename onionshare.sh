apt --fix-broken install

apt install python3-pip

pip3 install --user onionshare-cli

onionshare.cli --help

#share files
onionshare.cli --public /root/proxy-main/public/temp-main

#receive files
onionshare.cli --public --receive  --data-dir /root/proxy-main/

nohup onionshare.cli --public --chat --title "End GFW Chat" --persistent onionshare.chat.config >> chat.log 2>&1 &

nohup onionshare.cli --public --disable_csp --title "End GFW Web" --persistent onionshare.web.config --website /root/proxy-main/public/temp-main >> web.log 2>&1 &
