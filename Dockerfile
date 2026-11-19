FROM node:22-alpine

ENV NODE_ENV=production
ENV DATA_DIR=/data

WORKDIR /app
COPY . .

EXPOSE 4173
CMD ["node", "start.js"]
