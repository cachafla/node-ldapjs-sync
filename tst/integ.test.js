var add         = require('../lib/add.js');
var ldap        = require('ldapjs');
var log4js      = require('log4js');
var test        = require('tap').test;
var uuid        = require('node-uuid');
var vm          = require('vm');
var ldapjsRiak  = require('ldapjs-riak');
var ldapjsSync  = require('../lib/index');
var EntryQueue  = require('../lib/entryQueue');
var ReplContext = require('../lib/replContext');

var inMemLdap   = require('./inmemLdap');

///--- Globals
var SUFFIX        = 'o=yunong';
var SOCKET        = '/tmp/.' + uuid();
var REMOTE_PORT   = 23364;
var TOTAL_ENTRIES = 5;
var REMOTE_URL    = 'ldap://cn=root:secret@0.0.0.0:' + REMOTE_PORT + '/' +
                    SUFFIX + '??sub?(uid=*)';

var LOCAL_PORT    = 23456;
var LOCAL_URL     = 'ldap://cn=root:secret@localhost:' + LOCAL_PORT;

var ALL_CHANGES_CTRL = new ldap.PersistentSearchControl({
  type: '2.16.840.1.113730.3.4.3',
  value: {
    changeTypes: 15,
    changesOnly: false,
    returnECs: true
  }
});

var REPL_CONTEXT_OPTIONS = {
  log4js: log4js,
  url: REMOTE_URL,
  localUrl: LOCAL_URL,
  checkpointDn: SUFFIX,
  replSuffix: 'cn=repl, o=yunong'
};

var suffix = {
  objectClass: ['top', 'organization'],
  o: SUFFIX.split('=')[1],
  uid: uuid()
};

var localBackend;
var localClient = null;
var localLdap;

var remoteBackend;
var remoteClient;
var remoteLdap;


var entryQueue;
var url = ldap.url.parse(REMOTE_URL, true);

var replContext;
///--- Tests

test('setup-local', function(t) {
  inMemLdap.startServer({suffix: SUFFIX, port: LOCAL_PORT}, function(server) {
    t.ok(server);
    localClient = ldap.createClient({
      url: LOCAL_URL,
      log4js: log4js
    });

    localClient.once('connect', function(id) {
      t.ok(id);
      t.ok(localClient);
      console.log('local client connected');
      localClient.bind('cn=root', 'secret', function(err, res) {
        if (err) {
          t.fail(err);
        }
        t.ok(res);
        t.end();
      });
    });
  });
});

test('setup-remote', function(t) {
  var spawn = require('child_process').spawn;
  remoteLdap = spawn('node', ['./tst/remoteInmemldap.js'], {
    cwd: undefined,
    env: process.env,
    setsid: false
  });

  remoteLdap.stdout.on('data', function (data) {
    console.log('remote_stdout: ' + data);
  });

  remoteLdap.stderr.on('data', function (data) {
    console.log('remote_stderr: ' + data);
  });

  remoteLdap.on('exit', function (code) {
    console.log('remote_child process exited with code ' + code);
  });

  t.ok(remoteLdap);
  setTimeout(function() { t.end(); }, 1000);
});

test('setup-remote-client', function(t) {
  remoteClient = ldap.createClient({
    url: REMOTE_URL,
    log4js: log4js
  });

  remoteClient.once('connect', function(id) {
    t.ok(id);
    t.ok(remoteClient);
    console.log('remote client connected');
    remoteClient.bind('cn=root', 'secret', function(err, res) {
      if (err) {
        t.fail(err);
        t.end();
      }
      t.ok(remoteClient);
      t.end();
    });
    t.end();
  });
});

test('setup-replcontext', function(t) {
  REPL_CONTEXT_OPTIONS.localClient = localClient;
  replContext = new ReplContext(REPL_CONTEXT_OPTIONS);
  replContext.once('init', function(self) {
    t.ok(replContext);
    t.ok(replContext.checkpoint);
    t.ok(replContext.entryQueue);
    t.ok(replContext.localClient);
    t.ok(replContext.remoteClient);
    t.ok(replContext.url);
    t.ok(replContext.entryQueue);
    entryQueue = replContext.entryQueue;
    // we are technically good to go here after the init event, however, the
    // changelog psearch is asynchronous, so we have to wait here a bit while
    // that finishes. 3 seconds ought to do it.
    setTimeout(function(){ t.end(); }, 3000);
  });
});

test('add', function(t) {
  var entry = { objectclass: 'executor', uid: 'foo' };
  remoteClient.add('cn=supson, o=yunong', entry, function(err, res) {
    if (err) {
      t.fail(err);
    }

    entryQueue.on('popped', function(changelog, entryQueue) {
      localClient.search('cn=supson, o=yunong', function(err, res) {
        console.log('searching locally');
        if (err) {
          t.fail(err);
          t.end();
        }

        res.on('searchEntry', function(entry) {
          t.ok(entry);
          t.ok(entry instanceof ldap.SearchEntry);
          t.ok(entry.dn.toString());
          t.ok(entry.attributes);
          t.ok(entry.attributes.length);
          t.ok(entry.object);
          t.equal(entry.dn.toString(), 'cn=supson, o=yunong');
          // t.end();
        });

        res.on('error', function(err) {
          t.fail(err);
          t.end();
        });

        res.on('end', function(res) {
          t.end();
        });
      });
    });
  });
});

test('modify', function(t) {
  var change = {
    type: 'add',
    modification: {
      'pets': ['honey badger', 'bear']
    }
  };

  remoteClient.modify('cn=supson, o=yunong', change, function(err, res) {
    if (err) {
      t.fail(err);
      t.end();
    }
    entryQueue.on('popped', function(changelog, entryQueue) {
      localClient.search('cn=supson, o=yunong', function(err, res) {
        if (err) {
          t.fail(err);
          t.end();
        }

        res.on('searchEntry', function(entry) {
          t.ok(entry);
          t.ok(entry instanceof ldap.SearchEntry);
          t.ok(entry.dn.toString());
          t.ok(entry.attributes);
          t.ok(entry.attributes.length);
          t.ok(entry.object);
          t.equal(entry.dn.toString(), 'cn=supson, o=yunong');
          t.equal(entry.object.type, 'pets');
          t.equal(entry.object.vals[0], 'honey badger');
          t.equal(entry.object.vals[1], 'bear');
        });
        res.on('error', function(err) {
          t.fail(err);
        });
        res.on('end', function(res) {
          t.end();
        });
      });
    });
  });
});

// test('delete', function(t) {
//   remoteClient.del('cn=supson, o=yunong', function(err, res) {
//     if (err) {
//       t.fail(err);
//       t.end();
//     }
//     entryQueue.on('popped', function(changelog, entryQueue) {
//       localClient.search('cn=supson, o=yunong', function(err, res) {
//         if (err) {
//           t.fail(err);
//           t.end();
//         }
//         res.on('searchEntry', function(entry) {
//           t.fail('deleted entry should not exist locally');
//         });
//         res.on('error', function(err) {
//           t.equal(err.code, 32);
//           t.end();
//         });
//         res.on('end', function(res) {
//           t.end();
//         });
//       });
//     });
//   });
// });

test('tear-down', function(t) {
  if (remoteLdap) {
    // time this out so the loggers will flush
    setTimeout(function() { remoteLdap.kill(); }, 2000);
  }
  t.end();
});