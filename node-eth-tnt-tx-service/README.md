# TNT Token Service

This service is responsible for interacting with the token contract.  It allows querying of the balance of any address and also sending tokens to any specified target address.

This is available through a REST based API.

## Starting

```text
docker-compose up -d --build eth-tnt-tx-service
```

## REST API

To query the balance of an address:

```text
curl http://localhost:8085/balance/0x6a6d86907817db62e317bb21367f20e3802fbb66
```

To transfer tokens to a specified address (1500 TNT : 150000000000 grains in this example:

```text
curl -X POST \
  http://localhost:8085/transfer \
  -H 'cache-control: no-cache' \
  -H 'content-type: application/json' \
  -d '{ "to_addr": "0x6a6d86907817db62e317bb21367f20e3802fbb66", "value": "150000000000"}'
```

