# 修改 public/temp/custom.example/sponsor.txt

请参考

https://github.com/hello-world-1989/temp/blob/stable/public/temp/custom.example/sponsor.txt.example

以---三个破折号 分割 简介和内容， 

换行添加新内容

文件放置在end-gfw/custom文件夹中

比如end-gfw/custom/file.zip

上传修改过的sponsor.txt和要分享的文件

```

cd ~/end-gfw/custom

#上传修改过的 sponsor.txt到custom 文件夹

sudo wget -O sponsor.txt 存储sponsor.txt的链接(比如谷歌云盘, 不是共享链接， 需要先点击下载， 然后到 浏览器下载记录中找到文件并复制链接)

#上传要分享的文件

sudo wget -O file1.zip 文件下载链接

sudo wget -O file2.zip 文件下载链接


#重启服务
cd ~/end-gfw && sudo dc restart

```
