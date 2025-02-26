// Sapphire Specific:
// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
import { Args, Command, CommandOptions, container } from '@sapphire/framework';
import {
  Collection,
  Colors,
  Message,
  EmbedBuilder,
  MessageReaction,
  Snowflake,
  User,
} from 'discord.js';
import {
  adjustCoinBalanceByUserId,
  getCoinBalanceByUserId,
  UserCoinEvent,
} from '../../components/coin';
import { getCoinEmoji, getEmojiByName } from '../../components/emojis';
import {
  BlackjackAction,
  BlackjackHand,
  BlackjackStage,
  CardSuit,
  endGame,
  GameState,
  performGameAction,
  startGame,
} from '../../components/games/blackjack';
import { pluralize } from '../../utils/pluralize';
import { CodeyUserError } from '../../codeyUserError';

const DEFAULT_BET = 10;
const MIN_BET = 10;
const MAX_BET = 1000000;

const validateBetAmount = (amount: number): string => {
  if (amount < MIN_BET) return `minimum bet is ${MIN_BET} Codey coins.`;
  if (amount > MAX_BET) return `maximum bet is ${MAX_BET} Codey coins.`;
  return '';
};

// Sapphire Specific:
// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
export class GamesBlackjackCommand extends Command {
  public constructor(context: Command.Context, options: Command.Options) {
    super(context, {
      ...options,
      name: 'bj',
      aliases: ['blj'],
      description: 'Start a Blackjack game to win some Codey coins!',
      detailedDescription: `**Examples:**
\`${container.botPrefix}blackjack 100\`
\`${container.botPrefix}blj 100\``,
    });
  }
  /*
    Returns the corresponding emoji given the card's suit
  */
  private getSuitEmoji(suit: string): string {
    switch (suit) {
      case CardSuit.SPADES:
        return '♤';
      case CardSuit.HEARTS:
        return '♡';
      case CardSuit.CLUBS:
        return '♧';
      case CardSuit.DIAMONDS:
        return '♢';
      default:
        return '';
    }
  }

  /*
    Returns a string displaying a player's hand
  */
  private getHandDisplayString(hand: BlackjackHand): string {
    const cards = hand.map((card) => `${card.text}${this.getSuitEmoji(card.suite)}`).join(' ');
    return `Hand: ${cards}`;
  }

  /*
    Returns true if the reaction corresponds to a valid action and is from the player
  */
  private reactFilter(reaction: MessageReaction, user: User, authorId: string): boolean {
    return (
      reaction.emoji.name !== null &&
      ['🇸', '🇭', '🇶'].includes(reaction.emoji.name) &&
      user.id === authorId
    );
  }

  /*
    Performs a corresponding blackjack action depending on the player's reaction.
    Returns the game state after the action.
  */
  private async performActionFromReaction(
    collected: Collection<string | Snowflake, MessageReaction>,
    gameMessage: Message,
    playerId: string,
  ): Promise<GameState | null> {
    // Collect the first reaction
    const reaction = collected.first();
    // Remove the user's reaction once we've received it
    if (reaction) await gameMessage.reactions.resolve(reaction)?.users.remove(playerId);
    // Perform action according to reaction
    switch (reaction?.emoji.name) {
      case '🇸':
        return performGameAction(playerId, BlackjackAction.STAND);
      case '🇭':
        return performGameAction(playerId, BlackjackAction.HIT);
      case '🇶':
        return performGameAction(playerId, BlackjackAction.QUIT);
      default:
        return null;
    }
  }

  /*
    Waits for player's reaction and handle any corresponding actions.
  */
  private async handlePlayerAction(gameMessage: Message, playerId: string) {
    const reactFilter = (reaction: MessageReaction, user: User) =>
      this.reactFilter(reaction, user, playerId);
    // only waits for 1 valid reaction from the player, with a time limit of 1 minute.
    const reactCollector = await gameMessage.awaitReactions({
      filter: reactFilter,
      max: 1,
      time: 60000,
      errors: ['time'],
    });
    // perform action corresponding to reaction
    return await this.performActionFromReaction(reactCollector, gameMessage, playerId);
  }

  /*
    Returns a colour depending on the game's state
  */
  private getEmbedColourFromGame(game: GameState): keyof typeof Colors {
    if (game.stage === BlackjackStage.DONE) {
      if (this.getBalanceChange(game) < 0) {
        // player lost coins
        return 'Red';
      }
      if (this.getBalanceChange(game) > 0) {
        // player won coins
        return 'Green';
      }
      // player didn't lose any coins
      return 'Orange';
    }
    // game in progress
    return 'Yellow';
  }

  /*
    Returns the amount the player gains or loses from the game's current state.
  */
  private getBalanceChange(game: GameState): number {
    return game.amountWon - game.bet;
  }

  /*
    Returns a description of the game given the game's current state
  */
  private getDescriptionFromGame(game: GameState): string {
    const amountDiff = Math.abs(this.getBalanceChange(game));
    if (game.stage === BlackjackStage.DONE) {
      if (game.surrendered) {
        // player surrendered
        return `You surrendered and lost **${amountDiff}** Codey ${pluralize(
          'coin',
          amountDiff,
        )} ${getEmojiByName('codey_sad')}.`;
      }
      if (game.amountWon < game.bet) {
        // player lost
        return `You lost **${amountDiff}** Codey ${pluralize('coin', amountDiff)} ${getEmojiByName(
          'codey_sad',
        )}, better luck next time!`;
      }
      if (game.amountWon > game.bet) {
        // player won
        return `You won **${amountDiff}** Codey ${pluralize('coin', amountDiff)} ${getEmojiByName(
          'codey_love',
        )}, keep your win streak going!`;
      }
      // player tied with dealer
      return `Tied! You didn't win nor lose any Codey ${pluralize('coin', amountDiff)}, try again!`;
    }
    // game instruction
    return 'Press 🇭 to hit, 🇸 to stand, or 🇶 to quit.';
  }

  /*
    Returns the game embed from the game's current state
  */
  private getEmbedFromGame(game: GameState): EmbedBuilder {
    const embed = new EmbedBuilder().setTitle('Blackjack');
    embed.setColor(this.getEmbedColourFromGame(game));
    embed.addFields([
      // show bet amount and game description
      { name: `Bet: ${game.bet} ${getCoinEmoji()}`, value: this.getDescriptionFromGame(game) },
      // show player and dealer value and hands
      {
        name: `Player: ${game.playerValue.join(' or ')}`,
        value: this.getHandDisplayString(game.playerCards),
      },
      {
        name: `Dealer: ${game.dealerValue.join(' or ')}`,
        value: this.getHandDisplayString(game.dealerCards),
      },
    ]);

    return embed;
  }

  /*
    End game and update player balance.
  */
  private endGame(gameMessage: Message, playerId: string, balanceChange = 0) {
    gameMessage.reactions.removeAll();
    endGame(playerId);
    adjustCoinBalanceByUserId(playerId, balanceChange, UserCoinEvent.Blackjack);
  }

  async messageRun(message: Message, args: Args): Promise<Message | void> {
    try {
      // if there are no arguments, then resolve to the default bet amount; if there is only one argument and it is an
      // integer, then this is the bet amount; otherwise, reply that a valid bet amount must be entered
      const bet = args.finished
        ? DEFAULT_BET
        : await args.rest('integer').catch(() => {
            throw new CodeyUserError(message, 'please enter a valid bet amount.');
          });
      if (typeof bet === 'string') return message.reply(bet);

      const { author, channel } = message;

      const validateRes = validateBetAmount(bet);
      if (validateRes) {
        // if validation function returns an error message, then send it
        throw new CodeyUserError(message, validateRes);
      }

      // check player balance and see if it can cover the bet amount
      const playerBalance = await getCoinBalanceByUserId(author.id);
      if (playerBalance! < bet)
        throw new CodeyUserError(
          message,
          `you don't have enough coins to place that bet. ${getEmojiByName('codey_sad')}`,
        );

      // initialize the game
      let game = startGame(bet, author.id, channel.id);
      if (!game) {
        throw new CodeyUserError(
          message,
          'please finish your current game before starting another one!',
        );
      }

      // show game initial state and setup reactions
      const msg = await message.reply({ embeds: [this.getEmbedFromGame(game)] });
      if (game?.stage != BlackjackStage.DONE) {
        msg.react('🇭');
        msg.react('🇸');
        msg.react('🇶');
      }
      // keep handling player action until game is done
      while (game && game?.stage != BlackjackStage.DONE) {
        try {
          // wait for user action
          game = await this.handlePlayerAction(msg, author.id);
          await msg.edit({ embeds: [this.getEmbedFromGame(game!)] });
        } catch {
          // if player has not acted within time limit, consider it as quitting the game
          game = await performGameAction(author.id, BlackjackAction.QUIT);
          message.reply("you didn't act within the time limit, please start another game!");
          if (game) game.stage = BlackjackStage.DONE;
        }
      }
      if (game) {
        // update game embed
        await msg.edit({ embeds: [this.getEmbedFromGame(game)] });
        // end the game
        this.endGame(msg, author.id, this.getBalanceChange(game));
        return msg;
      }
    } catch (e) {
      if (e instanceof CodeyUserError) {
        e.sendToUser();
      }
    }
  }
}
