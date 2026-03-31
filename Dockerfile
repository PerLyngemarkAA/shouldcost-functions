FROM mcr.microsoft.com/azure-functions/node:4-node22

WORKDIR /home/site/wwwroot

COPY package.json .
RUN npm install --omit=dev

COPY . .

# DO NOT override CMD
# DO NOT run npm start
# DO NOT start the host yourself
