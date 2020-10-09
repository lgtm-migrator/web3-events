import { EventData, PastEventOptions } from 'web3-eth-contract'
import { Sema } from 'async-sema'
import type { BlockHeader, Eth } from 'web3-eth'

import { Contract } from './contract'
import Event from './event.model'
import {
  EventsEmitter, EventsEmitterEventsNames, EventsEmitterEmptyEvents,
  EventsEmitterOptions,
  Logger,
  NewBlockEmitter,
  INIT_FINISHED_EVENT_NAME,
  NEW_BLOCK_EVENT_NAME,
  NEW_EVENT_EVENT_NAME,
  REORG_EVENT_NAME, REORG_OUT_OF_RANGE_EVENT_NAME, ProgressInfo, PROGRESS_EVENT_NAME
} from './definitions'
import { AutoStartStopEventEmitter, errorHandler, hashTopics, initLogger } from './utils'
import { ModelConfirmator } from './confirmator'
import type { BlockTracker } from './block-tracker'
import type { EventInterface } from './event.model'

/**
 * Base class for EventsEmitter.
 * It supports block's confirmation, where new events are stored to DB and only after configured number of new
 * blocks are emitted to consumers for further processing.
 */
export abstract class BaseEventsEmitter<E extends EventData> extends AutoStartStopEventEmitter<EventsEmitterEventsNames<E>, EventsEmitterEmptyEvents> implements EventsEmitter<E> {
  public readonly blockTracker: BlockTracker
  protected readonly newBlockEmitter: NewBlockEmitter
  protected readonly startingBlock: string | number
  protected readonly eventNames?: string[]
  protected readonly contract: Contract
  protected readonly eth: Eth
  protected readonly semaphore: Sema
  protected readonly confirmations: number
  protected readonly topics?: (string[] | string)[]
  private readonly serialListeners?: boolean
  private readonly serialProcessing?: boolean
  private readonly confirmator?: ModelConfirmator
  private readonly batchSize: number
  private isInitialized = false
  private confirmationRoutine?: (...args: any[]) => void

  protected constructor (eth: Eth, contract: Contract, blockTracker: BlockTracker, newBlockEmitter: NewBlockEmitter, baseLogger: Logger, options?: EventsEmitterOptions) {
    super(initLogger('', baseLogger), NEW_EVENT_EVENT_NAME)
    this.eth = eth
    this.contract = contract
    this.eventNames = options?.events
    this.startingBlock = options?.startingBlock ?? 'genesis'
    this.confirmations = options?.confirmations ?? 0
    this.topics = hashTopics(options?.topics)
    this.batchSize = options?.batchSize ?? 120 // 120 blocks = RSK one hour of blocks
    this.semaphore = new Sema(1) // Allow only one caller
    this.blockTracker = blockTracker
    this.newBlockEmitter = newBlockEmitter
    this.serialListeners = options?.serialListeners
    this.serialProcessing = options?.serialProcessing

    if (!this.topics && !this.eventNames) {
      throw new Error('You have to specify options.topics or options.events!')
    }

    this.newBlockEmitter.on('error', (e) => this.emit('error', e))

    if (this.confirmations > 0) {
      this.confirmator = options?.confirmator ?? new ModelConfirmator(this, eth, contract.address, this.blockTracker, { baseLogger })
    }
  }

  /**
   * Serves for initialization of the EventsEmitter.
   * Specifically when this caching service is first launched this it will process past events.
   */
  async init (): Promise<void> {
    if (this.blockTracker.getLastFetchedBlock()[0] === undefined) {
      const from = this.startingBlock
      await this.processPastEvents(from, 'latest')
    }

    this.isInitialized = true
    this.emit(INIT_FINISHED_EVENT_NAME).catch(e => this.emit('error', e))
  }

  start (): void {
    if (!this.isInitialized) {
      this.init().catch(error => this.emit('error', error))
    }

    this.startEvents()

    if (this.confirmations > 0) {
      this.confirmationRoutine = errorHandler(this.confirmator!.runConfirmationsRoutine.bind(this.confirmator), this.logger)
      this.newBlockEmitter.on(NEW_BLOCK_EVENT_NAME, this.confirmationRoutine)
    }
  }

  stop (): void {
    this.stopEvents()

    if (this.confirmations > 0) {
      this.newBlockEmitter.off(NEW_BLOCK_EVENT_NAME, this.confirmationRoutine!)
    }
  }

  /**
   * Start fetching new events. Depends on specified strategy
   */
  protected abstract startEvents (): void

  /**
   * Stop fetching new events. Depends on specified strategy.
   */
  protected abstract stopEvents (): void

  /**
   * Method for processing events. It should be called after retrieving Events from blockchain.
   *
   * @param events
   * @param currentBlockNumber
   */
  protected async processEvents (events: E | E[], currentBlockNumber?: number): Promise<void> {
    currentBlockNumber = currentBlockNumber || await this.eth.getBlockNumber()

    if (!Array.isArray(events)) {
      events = [events]
    }

    if (this.eventNames) {
      events = events.filter(data => this.eventNames?.includes(data.event))
    }

    if (events.length === 0) {
      this.logger.info('No events to be processed.')
      return
    }

    if (this.confirmations === 0) {
      await this.emitEvents(events)
      return
    }

    const thresholdBlock = currentBlockNumber - this.confirmations
    this.logger.verbose(`Threshold block ${thresholdBlock}`)

    const eventsToBeConfirmed = events
      .filter(event => event.blockNumber > thresholdBlock)
    this.logger.info(`${eventsToBeConfirmed.length} events to be confirmed.`)

    try {
      await Event.bulkCreate(eventsToBeConfirmed.map(this.serializeEvent.bind(this))) // Lets store them to DB
    } catch (e) {
      if (e.name === 'SequelizeUniqueConstraintError') {
        throw new Error('Duplicated events!')
      }

      throw e
    }

    const eventsToBeEmitted = events
      .filter(event => event.blockNumber <= thresholdBlock)
    this.logger.info(`${eventsToBeEmitted.length} events to be emitted.`)

    await this.emitEvents(eventsToBeEmitted)
  }

  /**
   * Retrieves past events filtered out based on event's names passed to constructor.
   *
   * @param from
   * @param to
   */
  private async processPastEvents (from: number | string, to: number | string): Promise<void> {
    await this.semaphore.acquire()
    try {
      const currentBlock = await this.eth.getBlock('latest')

      if (from === 'genesis') {
        from = 0
      }

      if (to === 'latest') {
        to = currentBlock.number
      }

      this.logger.info('=> Processing past')
      const startTime = process.hrtime()
      await this.batchFetchAndProcessEvents(from as number, to as number, currentBlock)
      const [secondsLapsed] = process.hrtime(startTime)
      this.logger.info(`=> Finished processing past events in ${secondsLapsed}s`)
    } finally {
      this.semaphore.release()
    }
  }

  /**
   * Fetch and process events in batches.
   * The interval defined by fromBlock and toBlock is closed, eq. "or equal".
   *
   * @param fromBlock
   * @param toBlock
   * @param currentBlock
   */
  protected async batchFetchAndProcessEvents (fromBlock: number, toBlock: number, currentBlock: BlockHeader): Promise<void> {
    if (typeof fromBlock !== 'number' || typeof toBlock !== 'number') {
      throw new TypeError('fromBlock and toBlock has to be numbers!')
    }

    if (toBlock < fromBlock) {
      throw new Error('fromBlock has to be smaller then toBlock!')
    }

    const options: PastEventOptions = {}

    if (this.topics) {
      options.topics = this.topics
    }

    this.logger.info(`Fetching and processing events from block ${fromBlock} to ${toBlock}`)
    const countOfBatches = toBlock === fromBlock ? 1 : Math.ceil((toBlock - fromBlock) / (this.batchSize - 1))
    this.logger.verbose(`Will process ${countOfBatches} batches`)

    for (let batch = 0; batch < countOfBatches; batch++) {
      // The first batch starts at fromBlock sharp, but the others has to start +1 to avoid reprocessing of the bordering block
      let batchFromBlock, batchToBlock

      if (batch === 0) {
        batchFromBlock = fromBlock
        batchToBlock = Math.min(batchFromBlock + this.batchSize - 1, toBlock)
      } else {
        batchFromBlock = fromBlock + (batch * this.batchSize)
        batchToBlock = Math.min(batchFromBlock + this.batchSize - 1, toBlock)
      }

      const batchToBlockHeader = await this.eth.getBlock(batchToBlock)
      this.logger.verbose(`Processing batch no. ${batch + 1}: from block ${batchFromBlock} to ${batchToBlock}`)
      const events = (await this.contract.getPastEvents('allEvents', {
        fromBlock: batchFromBlock,
        toBlock: batchToBlock,
        ...options
      })) as unknown as E[]
      this.logger.debug('Received events for the batch: ', events)

      const progressInfo: ProgressInfo = {
        stepsComplete: batch + 1,
        totalSteps: countOfBatches,
        stepFromBlock: batchFromBlock,
        stepToBlock: batchToBlock
      }
      this.emit(PROGRESS_EVENT_NAME, progressInfo).catch(e => this.emit('error', e))

      await this.processEvents(events, currentBlock.number)
      this.blockTracker.setLastFetchedBlock(batchToBlockHeader.number, batchToBlockHeader.hash)
    }
  }

  protected async isReorg (): Promise<boolean> {
    const [lastFetchedBlockNumber, lastFetchedBlockHash] = this.blockTracker.getLastFetchedBlock()

    if (!lastFetchedBlockNumber) {
      return false // Nothing was fetched yet, no point in continue
    }

    const actualLastFetchedBlock = await this.eth.getBlock(lastFetchedBlockNumber)

    if (actualLastFetchedBlock.hash === lastFetchedBlockHash) {
      return false // No reorg detected
    }
    this.logger.warn(`Reorg happening! Old hash: ${lastFetchedBlockHash}; New hash: ${actualLastFetchedBlock.hash}`)

    const [lastProcessedBlockNumber, lastProcessedBlockHash] = this.blockTracker.getLastProcessedBlock()

    // If is undefined than nothing was yet processed and the reorg is not affecting our service
    // as we are still awaiting for enough confirmations
    if (lastProcessedBlockNumber) {
      const actualLastProcessedBlock = await this.eth.getBlock(lastProcessedBlockNumber)

      // The reorg is happening outside our confirmation range.
      // We can't do anything about it except notify the consumer.
      if (actualLastProcessedBlock.hash !== lastProcessedBlockHash) {
        this.logger.error(`Reorg out of confirmation range! Old hash: ${lastProcessedBlockHash}; New hash: ${actualLastProcessedBlock.hash}`)
        this.emit(REORG_OUT_OF_RANGE_EVENT_NAME, lastProcessedBlockNumber).catch(e => this.emit('error', e))
      }
    }

    this.emit(REORG_EVENT_NAME).catch(e => this.emit('error', e))
    return true
  }

  protected async handleReorg (currentBlock: BlockHeader): Promise<void> {
    const [lastProcessedBlockNumber] = this.blockTracker.getLastProcessedBlock()

    const newEvents = await this.contract.getPastEvents('allEvents', {
      fromBlock: (lastProcessedBlockNumber ? lastProcessedBlockNumber + 1 : false) || this.startingBlock,
      toBlock: currentBlock.number
    }) as unknown as E[]

    await this.confirmator!.checkDroppedTransactions(newEvents)

    // Remove all events that currently awaiting confirmation
    await Event.destroy({ where: { contractAddress: this.contract.address } })
    await this.processEvents(newEvents, currentBlock.number)
    this.blockTracker.setLastFetchedBlock(currentBlock.number, currentBlock.hash)
  }

  private async emitEvents (events: E[]): Promise<void> {
    const emittingFnc = this.serialListeners ? this.emitSerial.bind(this) : this.emit.bind(this)

    for (const data of events) {
      this.logger.debug('Emitting event', data)

      // Will await for all the listeners to process the event before moving forward
      if (this.serialProcessing) {
        try {
          await emittingFnc(NEW_EVENT_EVENT_NAME, data)
        } catch (e) {
          this.emit('error', e)
        }
      } else { // Does not await and just move on
        emittingFnc(NEW_EVENT_EVENT_NAME, data).catch(e => this.emit('error', e))
      }

      this.blockTracker.setLastProcessedBlockIfHigher(data.blockNumber, data.blockHash)
    }
  }

  private serializeEvent (data: EventData): EventInterface {
    this.logger.debug(`New ${data.event} event to be confirmed. Transaction ${data.transactionHash}.${data.logIndex}`)
    return {
      blockNumber: data.blockNumber,
      transactionHash: data.transactionHash,
      logIndex: data.logIndex,
      contractAddress: this.contract.address,
      event: data.event,
      targetConfirmation: this.confirmations,
      content: JSON.stringify(data)
    }
  }
}

/**
 * EventsEmitter implementation that uses polling for fetching new events from the blockchain.
 *
 * Polling is triggered using the NewBlockEmitter and is therefore up to the user
 * to chose what new-block strategy will employ.
 */
export class PollingEventsEmitter<E extends EventData> extends BaseEventsEmitter<E> {
  private pollingUnsubscribe?: Function

  constructor (eth: Eth, contract: Contract, blockTracker: BlockTracker, newBlockEmitter: NewBlockEmitter, baseLogger: Logger, options?: EventsEmitterOptions) {
    const logger = initLogger('events:polling', baseLogger)
    super(eth, contract, blockTracker, newBlockEmitter, logger, options)
  }

  async poll (currentBlock: BlockHeader): Promise<void> {
    this.logger.verbose(`Received new block number ${currentBlock.number}`)
    await this.semaphore.acquire()
    this.logger.verbose('Lock acquired')
    try {
      // Check if reorg did not happen since the last poll
      if (this.confirmations && await this.isReorg()) {
        return this.handleReorg(currentBlock)
      }

      const lastFetchedBlockNumber = this.blockTracker.getLastFetchedBlock()[0] as number

      // Nothing new, lets fast-forward
      if (lastFetchedBlockNumber === currentBlock.number) {
        this.logger.verbose('Nothing new to process')
        return
      }

      await this.batchFetchAndProcessEvents(
        lastFetchedBlockNumber + 1, // +1 because fromBlock and toBlock are "or equal", eq. closed interval, so we need to avoid duplications
        currentBlock.number,
        currentBlock
      )
    } catch (e) {
      this.logger.error('Error in the processing loop:\n' + JSON.stringify(e, undefined, 2))
    } finally {
      this.semaphore.release()
    }
  }

  startEvents (): void {
    this.logger.verbose('Starting listening on new blocks for polling new events')
    this.pollingUnsubscribe =
      this.newBlockEmitter.on(NEW_BLOCK_EVENT_NAME, errorHandler(this.poll.bind(this), this.logger))
  }

  stopEvents (): void {
    this.logger.verbose('Finishing listening on new blocks for polling new events')
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    this.pollingUnsubscribe && this.pollingUnsubscribe()
  }
}
