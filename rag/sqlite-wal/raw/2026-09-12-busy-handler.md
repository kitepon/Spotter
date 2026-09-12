出典: https://sqlite.org/c3ref/busy_handler.html
取得日: 2026-09-12
確度: 公式一次ソース。MarkItDownで変換し、相対リンクを出典の絶対URLへ解決。

[![SQLite](https://sqlite.org/images/sqlite370_banner.svg)](https://sqlite.org/index.html)

Small. Fast. Reliable.
Choose any three.

* [Home](https://sqlite.org/index.html)* Menu* [About](https://sqlite.org/about.html)* [Documentation](https://sqlite.org/docs.html)* [Download](https://sqlite.org/download.html)* [License](https://sqlite.org/copyright.html)* [Support](https://sqlite.org/support.html)* [Purchase](https://sqlite.org/prosupport.html)* Search

* [About](https://sqlite.org/about.html)* [Documentation](https://sqlite.org/docs.html)* [Download](https://sqlite.org/download.html)* [Support](https://sqlite.org/support.html)* [Purchase](https://sqlite.org/prosupport.html)

Search Documentation
Search Changelog

[## SQLite C Interface](https://sqlite.org/c3ref/intro.html)

## Register A Callback To Handle SQLITE\_BUSY Errors

> ```
> int sqlite3_busy_handler(sqlite3*,int(*)(void*,int),void*);
> ```

The sqlite3\_busy\_handler(D,X,P) routine sets a callback function X
that might be invoked with argument P whenever
an attempt is made to access a database table associated with
[database connection](https://sqlite.org/c3ref/sqlite3.html) D when another thread
or process has the table locked.
The sqlite3\_busy\_handler() interface is used to implement
[sqlite3\_busy\_timeout()](https://sqlite.org/c3ref/busy_timeout.html) and [PRAGMA busy\_timeout](https://sqlite.org/pragma.html#pragma_busy_timeout).

If the busy callback is NULL, then [SQLITE\_BUSY](https://sqlite.org/rescode.html#busy)
is returned immediately upon encountering the lock. If the busy callback
is not NULL, then the callback might be invoked with two arguments.

The first argument to the busy handler is a copy of the void\* pointer which
is the third argument to sqlite3\_busy\_handler(). The second argument to
the busy handler callback is the number of times that the busy handler has
been invoked previously for the same locking event. If the
busy callback returns 0, then no additional attempts are made to
access the database and [SQLITE\_BUSY](https://sqlite.org/rescode.html#busy) is returned
to the application.
If the callback returns non-zero, then another attempt
is made to access the database and the cycle repeats.

The presence of a busy handler does not guarantee that it will be invoked
when there is lock contention. If SQLite determines that invoking the busy
handler could result in a deadlock, it will go ahead and return [SQLITE\_BUSY](https://sqlite.org/rescode.html#busy)
to the application instead of invoking the
busy handler.
Consider a scenario where one process is holding a read lock that
it is trying to promote to a reserved lock and
a second process is holding a reserved lock that it is trying
to promote to an exclusive lock. The first process cannot proceed
because it is blocked by the second and the second process cannot
proceed because it is blocked by the first. If both processes
invoke the busy handlers, neither will make any progress. Therefore,
SQLite returns [SQLITE\_BUSY](https://sqlite.org/rescode.html#busy) for the first process, hoping that this
will induce the first process to release its read lock and allow
the second process to proceed.

The default busy callback is NULL.

There can only be a single busy handler defined for each
[database connection](https://sqlite.org/c3ref/sqlite3.html). Setting a new busy handler clears any
previously set handler. Note that calling [sqlite3\_busy\_timeout()](https://sqlite.org/c3ref/busy_timeout.html)
or evaluating [PRAGMA busy\_timeout=N](https://sqlite.org/pragma.html#pragma_busy_timeout) will change the
busy handler and thus clear any previously set busy handler.

The busy callback should not take any actions which modify the
database connection that invoked the busy handler. In other words,
the busy handler is not reentrant. Any such actions
result in undefined behavior.

A busy handler must not close the database connection
or [prepared statement](https://sqlite.org/c3ref/stmt.html) that invoked the busy handler.

See also lists of
[Objects](https://sqlite.org/c3ref/objlist.html),
[Constants](https://sqlite.org/c3ref/constlist.html), and
[Functions](https://sqlite.org/c3ref/funclist.html).