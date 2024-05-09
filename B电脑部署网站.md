

1. [下载并安装 Docker](https://www.docker.com/products/docker-desktop/), 仅支持英文

2. 安装完成后 点击 Search images to run

<img src='https://github.com/hello-world-1989/temp/blob/main/docker/step1.png' width='800' height='400' />

3.  搜索 endgfw/web, 找到endgfw/web:stable 并点击 Run

<img src='https://github.com/hello-world-1989/temp/blob/main/docker/step2.png' width='800' height='400' />

4.  点击 Optional Settings

<img src='https://github.com/hello-world-1989/temp/blob/main/docker/step3.png' width='800' height='400' />

5.  Ports中输入 8081, 点击Run

<img src='https://github.com/hello-world-1989/temp/blob/main/docker/step4.png' width='800' height='400' />

6. 访问 [http://localhost:8081](http://localhost:8081) 即可

设置让其他人访问

家庭路由器端口映射，只需要在家庭路由器中添加一条记录即可

大概步骤

1. 登录家庭路由器， 地址一般为192.168.1.1或 192.168.0.1等

2. 添加 NAT记录或路由规则或防火墙规则或端口映射等

3. 内网端口 填写以上8081， 内网地址 填写 本电脑IP地址， 外网端口填写 8081或 8888等

4. 谷歌或百度搜索 我的IP地址， http://我的IP地址:8081， 这样其它人就可以通过这个地址来访问, 并会显示在end-gfw.com 网站上
