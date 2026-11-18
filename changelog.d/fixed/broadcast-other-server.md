- **A send no longer fails because one light-client server stops answering.** When the server a send is broadcast through
  does not answer within its time limit, the coordinator sends the same signed transaction through the next server it
  has that is close to the others, within three minutes in all. Any other failure of the broadcast is reported as it is
  and not tried elsewhere. If no server takes it after a time-out, the message says the transaction may have reached
  the network and not to send it again before checking, since a server that timed out may have received it.
