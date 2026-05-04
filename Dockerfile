FROM node:18-slim
RUN apt-get update && apt-get install -y python3 python3-pip && pip3 install edge-tts --break-system-packages
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
