var net = require('net');
var ipaddr = require('ipaddr.js');
var ip = require('ip');
var util = require('util');
var SimpleBuffer = require('simple-buffer');

(function () {

    const COMMAND = {
        Connect: 0x01,
        Bind: 0x02,
        Associate: 0x03
    };

    const SOCKS4_RESPONSE = {
        Granted: 0x5A,
        Failed: 0x5B,
        Rejected: 0x5C,
        RejectedIdent: 0x5D
    };

    const SOCKS5_AUTH = {
        NoAuth: 0x00,
        GSSApi: 0x01,
        UserPass: 0x02
    };

    const SOCKS5_RESPONSE = {
        Granted: 0x00,
        Failure: 0x01,
        NotAllowed: 0x02,
        NetworkUnreachable: 0x03,
        HostUnreachable: 0x04,
        ConnectionRefused: 0x05,
        TTLExpired: 0x06,
        CommandNotSupported: 0x07,
        AddressNotSupported: 0x08
    };


    exports.createConnection = function (options, callback) {
        var socket = new net.Socket(), finished = false, buff = new SimpleBuffer();

        socket.wid = Math.floor(Math.random() * 1000);

        // Defaults
        options.timeout = options.timeout || 10000;
        options.proxy.command = commandFromString(options.proxy.command);
        options.proxy.userid = options.proxy.userid || "";

        var auth = options.proxy.authentication || {};
        auth.username = auth.username || "";
        auth.password = auth.password || "";

        options.proxy.authentication = auth;

        // Socket events
        socket.once('close', function () {
            finish(new Error("Socket Closed"), socket, null, callback);
        });

        socket.once('error', function (err) {
        });

        socket.once('connect', function () {
            if (options.proxy.type === 4) {
                negotiateSocks4(options, socket, callback);
            } else if (options.proxy.type === 5) {
                negotiateSocks5(options, socket, callback);
            } else {
                throw new Error("Please specify a proxy type in options.proxy.type");
            }
        });

        // Connect & negotiation timeout

        setTimeout(function () {
            finish(new Error("Connection Timed Out"), socket, null, callback);
        }, options.timeout);

        socket.connect(options.proxy.port, options.proxy.ipaddress);


        // 4 and 4a
        function negotiateSocks4(options, socket, callback) {
            buff.writeUInt8(0x04);
            buff.writeUInt8(options.proxy.command);
            buff.writeUInt16BE(options.target.port);

            // ipv4 or domain?
            if (net.isIPv4(options.target.host)) {
                buff.writeBuffer(new Buffer(ipaddr.parse(options.target.host).toByteArray()));
                buff.writeStringNT(options.proxy.userid);
            } else {
                buff.writeUInt8(0x00);
                buff.writeUInt8(0x00);
                buff.writeUInt8(0x00);
                buff.writeUInt8(0x01);
                buff.writeStringNT(options.proxy.userid);
                buff.writeStringNT(options.target.host);
            }

            socket.once('data', receivedResponse);
            socket.write(buff.toBuffer());

            function receivedResponse(data) {
                socket.pause();
                if (data.length === 8 && data[1] === SOCKS4_RESPONSE.Granted) {

                    if (options.proxy.command === COMMAND.Bind) {
                        buff.clear();
                        buff.skip(2);

                        var info = {
                            port: buff.readUInt16BE(),
                            host: buff.readUInt32BE()
                        };

                        if (info.host === 0) {
                            info.host = options.proxy.ipaddress;
                        } else {
                            info.host = ip.fromLong(info.host);
                        }

                        finish(null, socket, info, callback);
                    } else {
                        finish(null, socket, null, callback);
                    }

                } else {
                    finish(new Error("Rejected (" + data[1] + ")"), socket, null, callback);
                }
            }
        }

        function negotiateSocks5(options, socket, callback) {
            buff.writeUInt8(0x05);
            buff.writeUInt8(2);
            buff.writeUInt8(SOCKS5_AUTH.NoAuth);
            buff.writeUInt8(SOCKS5_AUTH.UserPass);

            socket.once('data', handshake);
            socket.write(buff.toBuffer());

            function handshake(data) {
                if (data.length !== 2) {
                    finish(new Error("Negotiation Error"), socket, null, callback);
                } else if (data[0] !== 0x05) {
                    finish(new Error("Negotiation Error (invalid version)"), socket, null, callback);
                } else if (data[1] === 0xFF) {
                    finish(new Error("Negotiation Error (unacceptable authentication)"), socket, null, callback);
                } else {
                    if (data[1] === SOCKS5_AUTH.NoAuth) {
                        sendRequest();
                    } else if (data[1] === SOCKS5_AUTH.UserPass) {
                        sendAuthentication(options.proxy.authentication);
                    } else {
                        finish(new Error("Negotiation Error (unknown authentication type)"), socket, null, callback);
                    }
                }
            }

            function sendAuthentication(authinfo) {
                buff.clear();
                buff.writeUInt8(0x01);
                buff.writeUInt8(Buffer.byteLength(authinfo.username));
                buff.writeString(authinfo.username);
                buff.writeUInt8(Buffer.byteLength(authinfo.password));
                buff.writeString(authinfo.password);

                socket.once('data', authenticationResponse);
                socket.write(buff.toBuffer());

                function authenticationResponse(data) {
                    if (data.length === 2 && data[1] === 0x00) {
                        sendRequest();
                    } else {
                        finish(new Error("Negotiation Error (authentication failed)"), socket, null, callback);
                    }
                }
            }

            function sendRequest() {
                buff.clear();
                buff.writeUInt8(0x05);
                buff.writeUInt8(options.proxy.command);
                buff.writeUInt8(0x00);

                // ipv4, ipv6, domain?
                if (net.isIPv4(options.target.host)) {
                    buff.writeUInt8(0x01);
                    buff.writeBuffer(new Buffer(ipaddr.parse(options.target.host).toByteArray()));
                } else if (net.isIPv6(options.target.host)) {
                    buff.writeUInt8(0x04);
                    buff.writeBuffer(new Buffer(ipaddr.parse(options.target.host).toByteArray()));
                } else {
                    buff.writeUInt8(0x03);
                    buff.writeUInt8(options.target.host.length);
                    buff.writeString(options.target.host);
                }
                buff.writeUInt16BE(options.target.port);

                socket.once('data', receivedResponse);
                socket.write(buff.toBuffer());
            }

            function receivedResponse(data) {
                socket.pause();
                if (data.length < 4) {
                    finish(new Error("Negotiation Error"), socket, null, callback);
                } else if (data[0] === 0x05 && data[1] === SOCKS5_RESPONSE.Granted) {
                    if (options.proxy.command === COMMAND.Connect) {
                        finish(null, socket, null, callback);
                    } else if (options.proxy.command === COMMAND.Bind || options.proxy.command === COMMAND.Associate) {
                        buff.clear();
                        buff.skip(3);

                        var info = {};
                        var addrtype = buff.readUInt8();

                        if (addrtype === 0x01) {
                            info.host = buff.readUInt32BE();
                            if (info.host === 0)
                                info.host = options.proxy.ipaddress;
                            else
                                info.host = ip.fromLong(info.host);
                        } else if (addrtype === 0x03) {
                            var len = buff.readUInt8();
                            info.host = buff.readString(len);
                        } else if (addrtype === 0x04) {
                            info.host = buff.readBuffer(16);
                        } else {
                            finish(new Error("Negotiation Error (invalid host address)"), socket, null, callback);
                        }
                        info.port = buff.readUInt16BE();

                        finish(null, socket, info, callback);
                    }
                } else {
                    finish(new Error("Negotiation Error (" + data[1] + ")"), socket, null, callback);
                }
            }
        }

        var finish = function (err, socket, info, callback) {
            if (!finished) {
                finished = true;

                console.log({ id: socket.wid, error: err});

                if (buff instanceof SimpleBuffer)
                    buff.destroy();

                if (err && socket instanceof net.Socket) {
                    socket.removeAllListeners('close');
                    socket.removeAllListeners('timeout');
                    socket.removeAllListeners('data');
                    socket.destroy();
                    socket = null;
                }
                callback(err, socket, info);
            }
        };

    };

    function commandFromString(str) {
        var result = COMMAND.Connect;

        if (str === "connect") {
            result = COMMAND.Connect;
        } else if (str === 'associate') {
            result = COMMAND.Associate;
        } else if (str === 'bind') {
            result = COMMAND.Bind;
        }

        return result;
    }

})();