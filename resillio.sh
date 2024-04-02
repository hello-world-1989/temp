wget https://download-cdn.resilio.com/2.7.3.1381/Debian/resilio-sync_2.7.3.1381-1_amd64.deb
sudo dpkg -i  resilio-sync_2.7.3.1381-1_amd64.deb

##auto start
sudo systemctl enable resilio-sync

##remove
##sudo apt-get purge resilio-sync

#change config file

##manual operation and revert once changed
#/etc/resilio-sync/config.json

127.0.0.1:8888

firewall public listen port 

sudo usermod -a -G ubuntu rslsync

sudo service resilio-sync restart

mkdir android/ windows/ mac/ linux/ ios/
folders="android/ windows/ mac/ linux/ ios/"

for folder in $folders; do
# Set the path to the folder
    folder_path="/root/proxy-main/public/temp-main/"$folder
    echo "Processing folder: $folder_path"
    # Iterate over files in the folder
        for file in "$folder_path"*; do
            if [ -f "$file" ]; then
                filename=${file##*/}
                echo "Processing file: $filename"
                ln $folder_path$filename $folder$filename
                # Add your processing logic here
            fi
        done
done

