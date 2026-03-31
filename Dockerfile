
FROM mcr.microsoft.com/azure-functions/node:4-node22
WORKDIR /home/site/wwwroot
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 80
CMD ["npm","start"]
