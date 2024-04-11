#docker build --no-cache -t web .
#docker tag web endgfw/web:stable
#docker push endgfw/web:stable

#docker build --no-cache -t web .
#docker tag web endgfw/web:dev
#docker push endgfw/web:dev
FROM node:lts-alpine

RUN apk --no-cache add git docker-cli curl bash tzdata && rm -rf /var/cache/apk/*

RUN sh -c "echo '10 */12 * * * docker restart end-gfw-web' >> /etc/crontabs/root"

RUN crond - restart

WORKDIR /app

RUN git clone https://github.com/hello-world-1989/temp.git

RUN cd temp && git config pull.rebase true

RUN cd /app/temp && git checkout stable && npm install

EXPOSE 80

CMD cd /app/temp && git pull && node src/proxy.js
