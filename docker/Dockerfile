#docker build --no-cache -t web .
#docker tag web endgfw/web:web-only
#docker push endgfw/web:web-only
FROM node:lts-alpine

RUN apk --no-cache add git

WORKDIR /app

RUN npm install --global http-server

RUN git clone https://github.com/hello-world-1989/temp.git

RUN cd temp && git config pull.rebase true

EXPOSE 8081

# CMD ["http-server", "temp", "-p", "8081", "-P", "https://end-gfw.com/"]

CMD cd /app/temp && git pull && cd /app && http-server temp -p 8081 -P https://end-gfw.com/
