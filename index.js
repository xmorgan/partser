'use strict'
const Partser = {}

const toString = thing => Object.prototype.toString.call(thing)

const isParser = (p) => {
  return (typeof p === 'function') && p[parserSymbol] === true
}

// For ensuring we have the right argument types
const assert = (name, check) => {
  return (fName, input) => {
    if (!check(input)) {
      throw new TypeError(`Partser.${fName}: Not a ${name}: ${toString(input)}`)
    }
  }
}
const assertParser = assert('parser', isParser)
const assertNumber = assert('number', (x) => typeof x === 'number')
const assertRegexp = assert('regex', (x) => x instanceof RegExp)
const assertFunction = assert('function', (x) => typeof x === 'function')
const assertString = assert('string', (x) => typeof x === 'string')

const skip = (parser, next) => {
  return Partser.map(Partser.seq(parser, next), ([x, _]) => x)
}

// A symbol that's added as a non-{enumerable,writable,configurable} property
// on every Parser instance, so we can distinguish them as clearly as possible
// from ordinary Functions.
//
// Ideally, we'd instead be making Parser a class so instanceof would work, but
// you can't do that while also having the instances of the class be callable,
// which I *really* want as an API.  It might be possible to do by extending
// the Function built-in, but that stuff is dark sorcery that I'd rather not
// have to think about.
const parserSymbol = Symbol('Partser parser identifying mark')

// Base parser constructor
const Parser = Partser.Parser = (behaviour) => {
  //
  // The `_` property contains the actual implementation of the parser's
  // behaviour.  It can be changed with the `replace` combinator, to change
  // behaviour while keeping this parser's identity the same.
  //
  // Internally, we want the parser to succeed if it matches even if it didn't
  // parse the full input string, so we can continue with the next parser.
  // This is what the base behaviour in `_` does.
  //
  // However, users would find this confusing; the expectation is for parsers
  // to fail unless they can match the whole input string!  Therefore, the
  // parser function itself actually parses for the base behaviour `_` followed
  // by `eof` (end of input).  Internally, we never use this surface API.
  //
  const parser = (stream, env, index = 0) =>
    skip(parser, Partser.eof)._(stream, index, env)
  parser._ = behaviour
  Object.defineProperty(parser, parserSymbol, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  })
  return parser
}

Partser.isParser = isParser

const makeSuccess = (index, value) =>
  ({ status: true, index, value })

const makeFailure = (index, expected) =>
  ({ status: false, index, value: [expected] })

const mergeOver = (() => {
  const furthest = (result) => result.status ? -1 : result.index
  const expected = (result) => result.value

  // Given a parse result and a previously existing failure, return whichever
  // is "better" (either because it succeeded, or because it matched more of
  // the input before before failing).  If they are equal failures, combine
  // their 'expected' values.
  return (next, previous) => {
    if (!previous || next.status || furthest(next) > furthest(previous)) return next
    else {
      return {
        status: false,
        index: next.index,
        value: expected(next).concat(expected(previous))
      }
    }
  }
})()

const formatExpected = (expected) => {
  if (expected.length === 1) return expected[0]
  else return 'one of ' + expected.join(', ')
}

const formatGot = (stream, error) => {
  const i = error.index
  const locationDescription = ` at character ${i}`

  if (i === stream.length) return `${locationDescription}, got end of input`
  else {
    const amountOfContext = 10
    const remainingCharsInStream = stream.length - i
    let actualValue = stream.slice(i, i + amountOfContext)
    if (remainingCharsInStream > i + amountOfContext) actualValue += '...'
    return `${locationDescription}, got '${actualValue}'`
  }
}

Partser.formatError = (stream, error) =>
  'expected ' + formatExpected(error.value) + formatGot(stream, error)

Partser.except = (allowed, forbidden) => {
  assertParser('except', allowed)
  assertParser('except', forbidden)
  return Parser((stream, i, env) => {
    const forbiddenResult = forbidden._(stream, i, env)
    if (forbiddenResult.status) {
      return makeFailure(i, `something that is not '${forbiddenResult.value}'`)
      // This error text is relatively unhelpful, as it only says what was
      // *not* expected, but this is all we can do.  Parsers only return an
      // "expected" value when they fail, and this fail branch is only
      // triggered when the forbidden parser succeeds.  Moreover, a parser's
      // expected value is not constant: it changes as it consumes more
      // characters.
      //
      // Ensure that it's clear to users that they really should use `desc`
      // to give instances of this parser a clearer name.
    } else {
      const allowedResult = allowed._(stream, i, env)
      if (allowedResult.status) return allowedResult
      else {
        return makeFailure(i, formatExpected(allowedResult.value) +
        ` (except ${formatExpected(forbiddenResult.value)})`)
      }
    }
  })
}

// deriveEnv is a user-provided function that creates a new environment based
// on the existing one.
Partser.subEnv = (baseParser, deriveEnv) => {
  assertFunction('subEnv', deriveEnv)
  return Parser((stream, i, env) => {
    const newEnv = deriveEnv(env)
    return baseParser._(stream, i, newEnv)
  })
}

Partser.from = (lookup) => {
  assertFunction('from', lookup)
  return Parser((stream, i, env) => {
    const foundParser = lookup(env)
    // Deliberately using isParser directly instead of calling assertParser, so
    // we can throw a more descriptive error if the value is bad.
    if (isParser(foundParser)) {
      return foundParser._(stream, i, env)
    } else {
      throw TypeError(`Partser.from: Non-parser value ${toString(foundParser)} from ${lookup}`)
    }
  })
}

Partser.seq = (...parsers) => {
  parsers.forEach((x) => assertParser('seq', x))
  return Parser((stream, i, env) => {
    let result
    const accum = new Array(parsers.length)

    for (let j = 0; j < parsers.length; j += 1) {
      result = mergeOver(parsers[j]._(stream, i, env), result)
      if (!result.status) return result
      accum[j] = result.value
      i = result.index
    }

    return mergeOver(makeSuccess(i, accum), result)
  })
}

const seqMap = (...args) => {
  const mapper = args.pop()
  return Partser.map(
    Partser.seq(...args),
    (results) => mapper(...results))
}

Partser.custom = (parsingFunction) => {
  assertFunction('custom', parsingFunction)
  return Parser(parsingFunction)
}

Partser.alt = (...parsers) => {
  if (parsers.length === 0) throw TypeError('Partser.alt: Zero alternates')
  parsers.forEach((x) => assertParser('alt', x))

  return Parser((stream, i, env) => {
    let result
    for (let j = 0; j < parsers.length; j += 1) {
      result = mergeOver(parsers[j]._(stream, i, env), result)
      if (result.status) return result
    }
    return result
  })
}

Partser.times = (parser, min, max) => {
  if (max === undefined) max = min

  assertParser('times', parser)
  assertNumber('times', min)
  assertNumber('times', max)

  return Parser((stream, i, env) => {
    const successes = []
    let times = 0
    let index = i
    let previousResult

    // First require successes until `min`.  In other words, return failure
    // if we mismatch before reaching `min` times.
    for (; times < min; ++times) {
      const result = parser._(stream, index, env)
      const mergedResult = mergeOver(result, previousResult)
      if (result.status) {
        previousResult = mergedResult
        index = result.index
        successes.push(result.value)
      } else return mergedResult
    }

    // Then allow successes up until `max`.  In other words, just stop on
    // mismatch, and return a success with whatever we've got by then.
    for (; times < max; ++times) {
      const result = parser._(stream, index, env)
      const mergedResult = mergeOver(result, previousResult)
      if (result.status) {
        previousResult = mergedResult
        index = result.index
        successes.push(result.value)
      } else break
    }

    return makeSuccess(index, successes)
  })
}

Partser.map = (parser, fn) => {
  assertFunction('map', fn)

  return Parser((stream, i, env) => {
    const result = parser._(stream, i, env)
    if (!result.status) return result
    return mergeOver(makeSuccess(result.index, fn(result.value, env)), result)
  })
}

Partser.mark = (parser) => {
  assertParser('mark', parser)

  return seqMap(
    Partser.index, parser, Partser.index,
    (start, value, end) => ({ start, value, end }))
}

Partser.lcMark = (parser) => {
  assertParser('lcMark', parser)

  return seqMap(
    Partser.lcIndex, parser, Partser.lcIndex,
    (start, value, end) => ({ start, value, end }))
}

Partser.desc = (parser, expected) => {
  assertParser('desc', parser)
  assertString('desc', expected)

  return Parser((stream, i, env) => {
    const reply = parser._(stream, i, env)
    if (!reply.status) reply.value = [expected]
    return reply
  })
}

Partser.string = (str) => {
  assertString('string', str)

  const len = str.length
  const expected = `'${str}'`

  return Parser((stream, i) => {
    const head = stream.slice(i, i + len)

    if (head === str) return makeSuccess(i + len, head)
    else return makeFailure(i, expected)
  })
}

Partser.regex = (re, group = 0) => {
  assertRegexp('regex', re)
  assertNumber('regex', group)

  const anchored = RegExp(
    `^(?:${re.source})`,
    `${re}`.slice(`${re}`.lastIndexOf('/') + 1))
  const expected = `${re}`

  return Parser((stream, i) => {
    const match = anchored.exec(stream.slice(i))

    if (match) {
      const fullMatch = match[0]
      const groupMatch = match[group]
      return makeSuccess(i + fullMatch.length, groupMatch)
    }

    return makeFailure(i, expected)
  })
}

Partser.succeed = (value) =>
  Parser((stream, i) => makeSuccess(i, value))

Partser.fail = (expected) => {
  assertString('fail', expected)
  return Parser((stream, i) => makeFailure(i, expected))
}

Partser.any = Parser((stream, i) => {
  if (i >= stream.length) return makeFailure(i, 'any character')
  return makeSuccess(i + 1, stream.charAt(i))
})

Partser.all = Parser((stream, i) =>
  makeSuccess(stream.length, stream.slice(i)))

Partser.eof = Parser((stream, i) => {
  if (i < stream.length) return makeFailure(i, 'EOF')
  return makeSuccess(i, null)
})

Partser.test = (predicate) => {
  assertFunction('test', predicate)

  return Parser((stream, i, env) => {
    const char = stream.charAt(i)
    if (i < stream.length && predicate(char, env)) {
      return makeSuccess(i + 1, char)
    } else {
      return makeFailure(i, 'a character matching ' + predicate)
    }
  })
}

Partser.index = Parser((stream, i) => makeSuccess(i, i))

Partser.lcIndex = Parser((stream, i) => {
  // Like the usual `index` function, but emitting an object that contains
  // line and column indices in addition to the character-based one.

  const lines = stream.slice(0, i).split('\n')

  // Unlike the character offset, lines and columns are 1-based.
  const lineWeAreUpTo = lines.length
  const columnWeAreUpTo = lines[lines.length - 1].length + 1

  return makeSuccess(i, {
    offset: i,
    line: lineWeAreUpTo,
    column: columnWeAreUpTo
  })
})

//
// Specials
//

Partser.clone = (parser) => {
  assertParser('clone', parser)
  return Partser.custom(parser._)
}

Partser.replace = (original, replacement) => {
  assertParser('replace', original)
  assertParser('replace', replacement)
  original._ = replacement._
}

Partser.chain = (parser, f) => {
  assertParser('chain', parser)
  assertFunction('chain', f)
  return Parser((stream, i, env) => {
    const result = parser._(stream, i, env)
    if (!result.status) return result
    const nextParser = f(result.value, env)
    return mergeOver(nextParser._(stream, result.index, env), result)
  })
}

module.exports = Partser
