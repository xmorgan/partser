var Parsimmon = {}

Parsimmon.Parser = (function () {
  'use strict'

  // The Parser object is a wrapper for a parser function.
  // Externally, you use one to parse a string by calling
  //   var result = SomeParser.parse('Me Me Me! Parse Me!')
  // You should never call the constructor, rather you should
  // construct your Parser from the base parsers and the
  // parser combinator methods.
  function Parser (action) {
    if (!(this instanceof Parser)) return new Parser(action)
    this._ = action
  }

  var _ = Parser.prototype

  function makeSuccess (index, value) {
    return {
      status: true,
      index: index,
      value: value,
      furthest: -1,
      expected: []
    }
  }

  function makeFailure (index, expected) {
    return {
      status: false,
      index: -1,
      value: null,
      furthest: index,
      expected: [expected]
    }
  }

  function mergeReplies (result, last) {
    if (!last) return result
    if (result.furthest > last.furthest) return result

    var expected = (result.furthest === last.furthest)
      ? result.expected.concat(last.expected)
      : last.expected

    return {
      status: result.status,
      index: result.index,
      value: result.value,
      furthest: last.furthest,
      expected: expected
    }
  }

  // For ensuring we have the right argument types
  function assertParser (p) {
    if (!(p instanceof Parser)) throw new Error('not a parser: ' + p)
  }
  function assertNumber (x) {
    if (typeof x !== 'number') throw new Error('not a number: ' + x)
  }
  function assertRegexp (x) {
    if (!(x instanceof RegExp)) throw new Error('not a regex: ' + x)
  }
  function assertfunction (x) {
    if (typeof x !== 'function') throw new Error('not a function: ' + x)
  }
  function assertString (x) {
    if (typeof x !== 'string') throw new Error('not a string: ' + x)
  }

  function formatExpected (expected) {
    if (expected.length === 1) return expected[0]

    return 'one of ' + expected.join(', ')
  }

  function formatGot (stream, error) {
    var i = error.index

    if (i === stream.length) return ', got the end of the stream'

    var prefix = (i > 0 ? "'..." : "'")
    var suffix = (stream.length - i > 12 ? "...'" : "'")

    return ' at character ' + i + ', got ' + prefix + stream.slice(i, i + 12) + suffix
  }

  Parsimmon.formatError = function (stream, error) {
    return 'expected ' + formatExpected(error.expected) + formatGot(stream, error)
  }

  var skip = function (parser, next) {
    return Parsimmon.map(seq(parser, next), function (r) { return r[0] })
  }

  Parsimmon.parse = function (parser, stream) {
    if (typeof stream !== 'string') {
      throw new Error('.parse must be called with a string as its argument')
    }
    var result = skip(parser, eof)._(stream, 0)

    return result.status ? {
      status: true,
      value: result.value
    } : {
      status: false,
      index: result.furthest,
      expected: result.expected
    }
  }

  // [Parser a] -> Parser [a]
  var seq = Parsimmon.seq = function () {
    var parsers = [].slice.call(arguments)
    var numParsers = parsers.length

    parsers.forEach(assertParser)

    return Parser(function (stream, i) {
      var result
      var accum = new Array(numParsers)

      for (var j = 0; j < numParsers; j += 1) {
        result = mergeReplies(parsers[j]._(stream, i), result)
        if (!result.status) return result
        accum[j] = result.value
        i = result.index
      }

      return mergeReplies(makeSuccess(i, accum), result)
    })
  }

  var seqMap = Parsimmon.seqMap = function () {
    var args = [].slice.call(arguments)
    var mapper = args.pop()
    return seq.apply(null, args).map(function (results) {
      return mapper.apply(null, results)
    })
  }

  /**
   * Allows to add custom primitive parsers
   */
  Parsimmon.custom = function (parsingFunction) {
    return Parser(parsingFunction(makeSuccess, makeFailure))
  }

  Parsimmon.alt = function () {
    var parsers = [].slice.call(arguments)
    var numParsers = parsers.length
    if (numParsers === 0) return fail('zero alternates')

    parsers.forEach(assertParser)

    return Parser(function (stream, i) {
      var result
      for (var j = 0; j < parsers.length; j += 1) {
        result = mergeReplies(parsers[j]._(stream, i), result)
        if (result.status) return result
      }
      return result
    })
  }

  // -*- primitive combinators -*- //

  // equivalent to:
  // _.times = function (min, max) {
  //   if (arguments.length < 2) max = min
  //   var self = this
  //   if (min > 0) {
  //     return self.then(function (x) {
  //       return self.times(min - 1, max - 1).then(function (xs) {
  //         return [x].concat(xs)
  //       })
  //     })
  //   }
  //   else if (max > 0) {
  //     return self.then(function (x) {
  //       return self.times(0, max - 1).then(function (xs) {
  //         return [x].concat(xs)
  //       })
  //     }).or(succeed([]))
  //   }
  //   else return succeed([])
  // }
  Parsimmon.times = function (parser, min, max) {
    if (arguments.length < 3) max = min
    var self = parser

    assertParser(self)
    assertNumber(min)
    assertNumber(max)

    return Parser(function (stream, i) {
      var accum = []
      var result
      var prevResult

      for (var times = 0; times < min; times += 1) {
        result = self._(stream, i)
        prevResult = mergeReplies(result, prevResult)
        if (result.status) {
          i = result.index
          accum.push(result.value)
        } else return prevResult
      }

      for (; times < max; times += 1) {
        result = self._(stream, i)
        prevResult = mergeReplies(result, prevResult)
        if (result.status) {
          i = result.index
          accum.push(result.value)
        } else break
      }

      return mergeReplies(makeSuccess(i, accum), prevResult)
    })
  }

  // -*- higher-level combinators -*- //
  Parsimmon.map = function (parser, fn) {
    assertfunction(fn)

    var self = parser
    return Parser(function (stream, i) {
      var result = self._(stream, i)
      if (!result.status) return result
      return mergeReplies(makeSuccess(result.index, fn(result.value)), result)
    })
  }

  _.mark = function () {
    return seqMap(index, this, index, function (start, value, end) {
      return { start: start, value: value, end: end }
    })
  }

  _.desc = function (expected) {
    var self = this
    return Parser(function (stream, i) {
      var reply = self._(stream, i)
      if (!reply.status) reply.expected = [expected]
      return reply
    })
  }

  // -*- primitive parsers -*- //
  Parsimmon.string = function (str) {
    var len = str.length
    var expected = "'" + str + "'"

    assertString(str)

    return Parser(function (stream, i) {
      var head = stream.slice(i, i + len)

      if (head === str) {
        return makeSuccess(i + len, head)
      } else {
        return makeFailure(i, expected)
      }
    })
  }

  Parsimmon.regex = function (re, group) {
    assertRegexp(re)
    if (group) assertNumber(group)

    var anchored = RegExp('^(?:' + re.source + ')', ('' + re).slice(('' + re).lastIndexOf('/') + 1))
    var expected = '' + re
    if (group == null) group = 0

    return Parser(function (stream, i) {
      var match = anchored.exec(stream.slice(i))

      if (match) {
        var fullMatch = match[0]
        var groupMatch = match[group]
        if (groupMatch != null) return makeSuccess(i + fullMatch.length, groupMatch)
      }

      return makeFailure(i, expected)
    })
  }

  var succeed = Parsimmon.succeed = function (value) {
    return Parser(function (stream, i) {
      return makeSuccess(i, value)
    })
  }

  var fail = Parsimmon.fail = function (expected) {
    return Parser(function (stream, i) { return makeFailure(i, expected) })
  }

  Parsimmon.any = Parser(function (stream, i) {
    if (i >= stream.length) return makeFailure(i, 'any character')

    return makeSuccess(i + 1, stream.charAt(i))
  })

  Parsimmon.all = Parser(function (stream, i) {
    return makeSuccess(stream.length, stream.slice(i))
  })

  var eof = Parsimmon.eof = Parser(function (stream, i) {
    if (i < stream.length) return makeFailure(i, 'EOF')

    return makeSuccess(i, null)
  })

  var test = Parsimmon.test = function (predicate) {
    assertfunction(predicate)

    return Parser(function (stream, i) {
      var char = stream.charAt(i)
      if (i < stream.length && predicate(char)) {
        return makeSuccess(i + 1, char)
      } else {
        return makeFailure(i, 'a character matching ' + predicate)
      }
    })
  }

  Parsimmon.oneOf = function (str) {
    return test(function (ch) { return str.indexOf(ch) >= 0 })
  }

  Parsimmon.noneOf = function (str) {
    return test(function (ch) { return str.indexOf(ch) < 0 })
  }

  Parsimmon.takeWhile = function (predicate) {
    assertfunction(predicate)

    return Parser(function (stream, i) {
      var j = i
      while (j < stream.length && predicate(stream.charAt(j))) j += 1
      return makeSuccess(j, stream.slice(i, j))
    })
  }

  Parsimmon.lazy = function (desc, f) {
    if (arguments.length < 2) {
      f = desc
      desc = undefined
    }

    var parser = Parser(function (stream, i) {
      parser._ = f()._
      return parser._(stream, i)
    })

    if (desc) parser = parser.desc(desc)

    return parser
  }

  var index = Parsimmon.index = Parser(function (stream, i) {
    return makeSuccess(i, i)
  })

  // fantasyland compat

  // Monoid (Alternative, really)
  _.concat = _.or
  _.empty = fail('empty')

  // Applicative
  _.of = Parser.of = Parsimmon.of = succeed

  _.ap = function (other) {
    return seqMap(this, other, function (f, x) { return f(x) })
  }

  // Monad
  _.chain = function (f) {
    var self = this
    return Parser(function (stream, i) {
      var result = self._(stream, i)
      if (!result.status) return result
      var nextParser = f(result.value)
      return mergeReplies(nextParser._(stream, result.index), result)
    })
  }

  return Parser
})()
module.exports = Parsimmon

