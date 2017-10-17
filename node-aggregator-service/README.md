# chainpoint-node-aggregator-service

## Configuration
Configuration parameters will be stored in environment variables. Environment variables can be overridden throught the use of a .env file. 

The following are the descriptions of the configuration parameters:

| Name           | Description  |
| :------------- |:-------------|
| RMQ\_PREFETCH\_COUNT | the maximum number of messages sent over the channel that can be awaiting acknowledgement |
| RMQ\_WORK\_IN\_QUEUE     | the queue name for message consumption originating from the api service |
| RMQ\_WORK\_OUT\_STATE\_QUEUE       | the queue name for outgoing message to the proof state service |
| AGGREGATION_INTERVAL       | how often the aggregation process should run, in milliseconds | 
| HASHES\_PER\_MERKLE_TREE     | maximum number of hashes the aggregation process will consume per aggregation interval | 
| RABBITMQ\_CONNECT\_URI       | RabbitMQ connection URI |

The following are the types, defaults, and acceptable ranges of the configuration parameters: 

| Name           | Type         | Default | Min | Max |
| :------------- |:-------------|:-------------|:----|:--------|
| RMQ\_PREFETCH\_COUNT      | integer      | 0 | 0 | - | 
| RMQ\_WORK\_IN\_QUEUE      | string      | 'work.agg' |  |  | 
| RMQ\_WORK\_OUT\_STATE\_QUEUE       | string      | 'work.state' |  |  | 
| AGGREGATION_INTERVAL       | integer       | 1,000 | 250 | 10,000 | 
| HASHES\_PER\_MERKLE_TREE     | integer       | 1,000 | 100 | 25,000 | 
| RABBITMQ\_CONNECT\_URI       | string      | 'amqp://chainpoint:chainpoint@rabbitmq' |  |  |

Any values provided outside accepted ranges will result in service failure.


## Data In
The service will receive persistent hash object messages from a durable queue within RabbitMQ. The queue name is defined by the RMQ\_WORK\_IN\_QUEUE  configuration parameter.

The following is an example of a hash object message body: 
```json
{
  "hash_id": "34712680-14bb-11e7-9598-0800200c9a66",
  "hash": "39ec487d38b828c6f9ef5d1e8128c76c7455d0f5cbf7ce9b8ef550cf223dfbc3"
}
```
| Name | Description                                                            |
| :--- |:-----------------------------------------------------------------------|
| hash_id   | The UUIDv1 unique identifier for a hash object with embedded timestamp |
| hash | A hex string representing the hash to be processed                     |

As hash objects are received, they are temporarily stored in the HASHES array until they are consumed by the aggregation process. The RMQ message is also appended to the hash object so that it may be referenced and acked once it has been processed.


## Aggregation Process [aggregate]
This process is executed at the interval defined by the AGGREGATION\_INTERVAL configuration parameter. The maximum number of hashes to read for any given aggregation process is defined by the HASHES\_PER\_MERKLE\_TREE configuration parameter. Hashes are simultaneously removed from the HASHES array and added to the hashesForTree array. The HASHES array will continue to receive new hashes while the aggregation method works with those in the hashesForTree array.

A Merkle tree is constructed for all hashes in hashesForTree. The leaves being added to the tree are hashes defined as **H1=SHA256(hash_id|hash)**. 

| Name | Description                                                            |
| :--- |:-----------------------------------------------------------------------|
| hash_id   | A buffer containing the bytes of the hash object hash\_id’s string representation |
| hash | A buffer containing the bytes of the submitted hash                    |

The resulting H1 values are stored within a leaves array to be used later when building the start of the overall proof path. All H1 values are then added as leaves to a merkle tree, and the merkle tree is constructed. 

A treeData object is created that contains the results of this aggregation event. When the treeData object is created, it is queued for the proof state service to consume.

For each leaf on the tree, the proof path to the merkle root is calculated, converted to a Chainpoint v3 ops list, and stored within the treeObject's proofData.proof array. These proof paths are prepeneded with the additional hash operation representing the earlier H1=SHA256(id|hash) calculation. The original hash_id, hash, and hash object message are appended.

The following is an example of a treeData object sent to the proof state service:
```json
{
  "agg_id": "0cdecc3e-2452-11e7-93ae-92361f002671", // a UUIDv1 for this aggregation event
  "agg_root": "419001851bcf08329f0c34bb89570028ff500fc85707caa53a3e5b8b2ecacf05",
  "proofData": [
    {
      "hash_id": "34712680-14bb-11e7-9598-0800200c9a66",
      "hash": "a0ec06301bf1814970a70f89d1d373afdff9a36d1ba6675fc02f8a975f4efaeb",
      "proof": [ /* Chainpoint v3 ops list for leaf 0 ... */ ]
    },
    {
      "hash_id": "6d627180-1883-11e7-a8f9-edb8c212ef23",
      "hash": "2222d5f509d86e2627b1f498d7b44db1f8e70aae1528634580a9b68f05d57a9f",
      "proof": [ /* Chainpoint v3 ops list for leaf 1 ... */ ]
    },
    { /* more ... */ },
  ]
}
```

## Service Failure
In the event of any error occurring, the service will log that error to STDERR and kill itself with a process.exit(). RabbitMQ will be configured so that upon service exit, unacknowledged messages will be requeued to ensure than unfinished work lost due to failure will be processed again in full.


## Notable NPM packages
| Name         | Description                                                            |
| :---         |:-----------------------------------------------------------------------|
| envalid       | for managing and validating environment variables |
| merkle-tools | for constructing merkle tree and calculating merkle paths |
| amqplib      | for communication between the service and RabbitMQ |






