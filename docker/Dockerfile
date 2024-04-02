FROM node:lts-alpine

RUN apk --no-cache add git

WORKDIR /app

RUN npm install --global http-server

RUN git clone https://github.com/hello-world-1989/temp.git

EXPOSE 8081

CMD ["http-server", "temp", "-p", "8081", "-P", "https://end-gfw.com/"]
