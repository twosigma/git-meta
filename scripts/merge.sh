echo "Setting up 'slim merge' demo"
{
    rm -rf merge-demo
    mkdir merge-demo
    cd merge-demo
    git init --bare meta-bare
    git clone meta-bare meta
    cd meta
    touch README.md
    git add README.md
    git com -m rm
    git push origin master
    cd ..
    git init --bare x-bare
    git clone x-bare x
    cd x
    touch foo
    git add foo
    git com -m "first x"
    git push origin master
    cd ..
    git init --bare y-bare
    git clone y-bare y
    cd y
    touch bar
    git add bar
    git com -m "first y"
    git push origin master
    cd ..
    git init --bare z-bare
    git clone z-bare z
    cd z
    touch bam
    git add bam
    git com -m "first z"
    git push origin master
    cd ..
    cd meta
    sl include ../x-bare x
    sl include ../y-bare y
    sl commit -m "added subs"
    sl push
    sl checkout other
    cd x
    touch baz
    git add baz
    cd ../y
    touch howz
    git add howz
    cd ..
    sl commit -am "added things"
    sl push
    cd x
    touch zab
    git add zab
    cd ../y
    touch zwoh
    git add zwoh
    cd ..
    sl commit -am "added other things"
    sl push
    sl include ../z-bare z
    sl commit -am "added z"
    sl push
    sl checkout master
    cd x
    echo asdfas >> foo
    cd ../y
    echo aaaaaaaa >> bar
    cd ..
    sl commit -am "changed things"
    sl push
    sl close x
} &> /dev/null
