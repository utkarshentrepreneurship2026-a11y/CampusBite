# CampusBite — Production Deployment Package

This package is the single deployment candidate for CampusBite.

## Architecture

- Customer and staff clients use the same Node/Express API.
- PostgreSQL is the source of truth for customers, wallets, transactions, orders, menu availability, and staff status changes.
- Browser localStorage is used only for the login token/session and the selected-shop UI preference. Orders, wallet balances, expenditure, transactions, and auto-pay are NOT stored in localStorage.
- Customer clients poll the API every 3 seconds for account/order/menu updates.
- Staff clients poll the API every 3 seconds for shop orders and daily summary data.
- Staff status transitions are enforced server-side: Received -> Preparing -> Ready -> Completed.
- Staff access is restricted to the authenticated staff member's assigned shop.
- Daily revenue/order counts use the Asia/Kolkata calendar date and are recalculated on every staff refresh/poll, so they roll over automatically when the date changes.

## Render

The included `render.yaml` provisions:
- one Node web service
- one PostgreSQL database
- `DATABASE_URL` from the database connection string
- a generated `JWT_SECRET`
- `NODE_ENV=production`

Build command: `npm install`
Start command: `npm start`

## Important

Do not deploy the standalone HTML preview. Deploy the contents of this package as the Render/Git repository root.

The server initializes the database schema and menu records on startup; customer and staff accounts are created through sign-up. Existing database rows are preserved; menu prices are synchronized with the application seed values.

## Live verification after deployment

1. Open the live site on Device A and log in as a customer.
2. Place an order.
3. Open the live site on Device B and log in as the appropriate shop staff.
4. Confirm the order appears there.
5. Advance it through Preparing, Ready, and Completed.
6. Confirm Device A receives the updated status within the polling interval.
7. Confirm wallet balance, transaction history, and total expenditure persist after logout/login.
8. Enable auto-pay and verify the server-side refill when the threshold condition is met.
9. Confirm staff Today's Orders/Revenue are based on the current India date.


## Accounts
Customer and staff accounts are created through the Sign up flow and stored persistently in PostgreSQL. No demo login accounts are seeded.

## Customer pickup time

Checkout supports ASAP or scheduled pickup from 3:00 PM through 9:00 PM in 30-minute increments. The server validates the selected pickup slot.

## Smart menu labels

Menu cards show indicative tags such as Vegetarian, Non-veg, Contains gluten, Contains dairy, Spicy, Gluten-free, Popular, Low stock, and Best value.


## Database initialization
On startup, the server applies `schema.sql` and seeds/updates the menu as needed. A one-time migration
removes only the two legacy customer demo IDs (`CB2026001` and `CB2026002`) from an existing database,
then records that migration as complete. Registered customer and staff accounts are never deleted by
server startup, restart, or redeploy. This also allows a fresh PostgreSQL database (including a new Render
or Supabase database) to start without manually creating `menu_items` first.


Account persistence: registered customer and staff accounts are stored in PostgreSQL. The two legacy customer demo IDs (CB2026001 and CB2026002) are removed once by a migration marker; no recurring startup account cleanup is performed. Customer state is loaded by account ID after sign-in, including wallet, wallet transactions, and order history.
