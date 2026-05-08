export const defaults: Record<string, string> = {
  already_confirmed: `This trade has already been confirmed. If you believe this to be in error, please contact the moderators.`,

  cant_confirm_username: `You can not confirm this trade; your username was not specified.

The comment by \`u/{parent_author}\` must tag you using the format \`u/{author_name}\` for you to confirm.
`,

  monthly_post_title: `%B %Y Confirmed Trade Thread`,

  monthly_post: `Submit your trade confirmations below

* [**{previous_month_submission.title}**]({previous_month_submission.permalink})
* [**Full List of Subreddit Rules**](https://www.reddit.com/r/{subreddit_name}/wiki/rules/)
* [**Message the Moderators**](http://www.reddit.com/message/compose?to=%2Fr%2F{subreddit_name})

# How Does This Process Work?

> Note: Trade confirmations may take a few minutes as the bot processes the confirmation.

After completing a trade, adhering to the rules listed above, either party involved should make a top-level comment (i.e., comment on the post, not on someone else's comment) declaring the trade. In this comment, tag the other Redditor by typing their username, including the leading \`u/\`. This action serves a dual purpose: it notifies the other Redditor to confirm the trade, and it alerts \`u/{bot_name}\` to monitor for the confirmation. The other Redditor should then reply to this comment (i.e., do not create another top-level comment; instead, reply to the initial comment) to indicate that the trade was successful.

> **Important:** It's advisable to WAIT until the trade is successfully completed—meaning all money/items have been properly exchanged—before posting your confirmation.

Example:
1. \`u/NitroFish44\` comments: \`Sold a Sailor S-Broad nib to u/thisisreallytricky\`
2. \`u/thisisreallytricky\` replies: \`Confirmed! Placed the nib in a more modern Sailor pen and LOVE the way it writes!!\`
3. \`u/{bot_name}\` replies to \`u/thisisreallytricky\`'s comment indicating that their trade counts have been updated.

# FAQ

1. The bot mentioned that additional information is required. What should I do?
    > If this occurs, it suggests that the bot couldn't find enough information to confirm the trade. Please [message the moderators](http://www.reddit.com/message/compose?to=%2Fr%2F{subreddit_name}), who can review and approve the trade by replying \`Approved\` to your trade comment.

2. The bot didn't respond to my comment. What's wrong?
    > Did you comment \`Confirmed\`? If not, add a NEW comment reply stating \`Confirmed\`. Avoid editing the existing comment. If you did reply \`Confirmed\` but received no response, please [message the moderators](http://www.reddit.com/message/compose?to=%2Fr%2F{subreddit_name}). The bot might be experiencing issues!
`,

  old_confirmation_thread: `Utilize the newest confirmation thread to start a new confirmation, even if this confirmation applies to a previous month's trade.`,

  trade_confirmation: `[\`u/{confirmer}\`](https://reddit.com/u/{confirmer}) updated from \`{old_comment_flair}\` to \`{new_comment_flair}\`


[\`u/{parent_author}\`](https://reddit.com/u/{parent_author}) updated from \`{old_parent_flair}\` to \`{new_parent_flair}\`
`,
}
