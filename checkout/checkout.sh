echo "Setting up 'slim checkout' demo"
{
    rm -rf checkout-demo
    mkdir checkout-demo
    cd checkout-demo
    sl init meta
    git init x
    cd x
    touch foo
    git add foo
    git com -m "first x"
    cd ..
    git init y
    cd y
    touch bar
    git add bar
    git com -m "first y"
    cd ..
    cd meta
    sl include ../x x
    sl include ../y y
    sl commit -m "added subs"
    sl checkout my-feature
    cd x
    echo foofoo >> foo
    cd ../y
    echo barbar >> bar
    cd ..
    sl commit -am changes
    sl checkout master
} &> /dev/null
