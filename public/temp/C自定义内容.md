# 修改 public/temp/custom/sponsor.txt
以---三个破折号 分割 简介和内容

换行添加新内容

文件放置在public/temp/custom/文件夹中

比如/custom/file.zip

上传修改过的sponsor.txt和要分享的文件

```

cd ~/end-gfw/custom

#上传修改过的 sponsor.txt到custom 文件夹

wget -O sponsor.txt 存储sponsor.txt的链接(比如谷歌云盘)

#上传要分享的文件

wget -O file1.zip 文件下载链接

wget -O file2.zip 文件下载链接

#重启服务
sudo dc restart

```
