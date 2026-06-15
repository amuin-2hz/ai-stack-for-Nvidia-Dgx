FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app
RUN apk add --no-cache bash

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 8000
CMD ["npm", "run", "start"]
