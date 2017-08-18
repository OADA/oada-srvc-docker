'use strict';

const config = require('../config');
const db = require('../db');
const aql = require('arangojs').aql;
const util = require('../util');

function findById(id) {
  return db.query(aql`
      FOR c IN ${db.collection(config.get('arangodb:collections:clients:name'))}
      FILTER c.clientId == ${id}
      RETURN c`
    )
    .call('next')
    .then((client) => {
      if (!client) {
        return null;
      }

      return util.sanitizeResult(client);
    });
}

function save(client) {
  return db.collection(config.get('arangodb:collections:clients:name'))
    .save(client)
    .then(() => findById(client.clientId));
}

module.exports = {
  findById,
  save
};
