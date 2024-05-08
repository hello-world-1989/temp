#!/bin/bash

# URL of the remote JSON file
url="https://raw.githubusercontent.com/hello-world-1989/temp/main/vpn.json"
# url="https://raw.githubusercontent.com/hello-world-1989/temp/main/ee.json"

json_data=$(curl -s "$url")
oss=($(echo $json_data | jq -r '.[].os'))
ids=($(echo $json_data | jq -r '.[].id'))
links=($(echo $json_data | jq -r '.[].link2'))
# Get the length of the JSON array

length=${#links[@]}

# Loop through each element in the JSON array
for ((i = 0; i < length; i++)); do
    os=${oss[i]}
    id=${ids[i]}
    link=${links[i]}

    if [[ $link != *"#"* ]]; then
        echo "Element $((i+1)): link=$os, link=$id, link=$link"
        mkdir -p $os
        wget -O $os/$os-$id.zip $link
    fi
done

